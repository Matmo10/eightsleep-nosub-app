import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile, users, sleepProfiles, type SleepPhase } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { obtainFreshAccessToken } from "~/server/eight/auth";
import { type Token } from "~/server/eight/types";
import { turnOffSide, setPreheat } from "~/server/eight/eight";
import { getCurrentHeatingStatus } from "~/server/eight/user";

export const runtime = "nodejs";

function createDateWithTime(baseDate: Date, timeString: string): Date {
  const [hours, minutes] = timeString.split(':').map(Number);
  if (hours === undefined || minutes === undefined || isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time string: ${timeString}`);
  }
  const result = new Date(baseDate);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

async function retryApiCall<T>(apiCall: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await apiCall();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error("This should never happen due to the for loop, but TypeScript doesn't know that");
}

/**
 * Check if `now` falls within [start, end), handling overnight wraparound.
 */
function isInTimeWindow(now: Date, start: Date, end: Date): boolean {
  if (start <= end) {
    return now >= start && now < end;
  } else {
    return now >= start || now < end;
  }
}

interface PhaseResult {
  level: number | null; // null = turn off, number = set this level
  isActive: boolean;    // false = no phase covers the current time
  phaseStartTime: Date | null; // when the current phase started
}

/**
 * Given the current time and a list of phases, find which phase is currently active.
 * Handles overnight schedules by checking both today's and yesterday's occurrences.
 */
function getCurrentPhaseLevel(userNow: Date, phases: SleepPhase[]): PhaseResult {
  if (phases.length === 0) return { level: null, isActive: false, phaseStartTime: null };

  // Convert phase times to Dates on the same day as userNow, plus yesterday's versions
  interface PhaseCandidate {
    level: number | null;
    startTime: Date;
    isLast: boolean;
  }

  const candidates: PhaseCandidate[] = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!;
    const isLast = i === phases.length - 1;

    // Today's occurrence
    const todayTime = createDateWithTime(userNow, phase.time);
    if (userNow >= todayTime) {
      candidates.push({ level: phase.level, startTime: todayTime, isLast });
    }

    // Yesterday's occurrence (for overnight schedules)
    const yesterdayTime = new Date(todayTime);
    yesterdayTime.setDate(yesterdayTime.getDate() - 1);
    if (userNow >= yesterdayTime) {
      candidates.push({ level: phase.level, startTime: yesterdayTime, isLast });
    }
  }

  if (candidates.length === 0) return { level: null, isActive: false, phaseStartTime: null };

  // Pick the candidate with the latest start time (most recently started phase)
  candidates.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  const best = candidates[0]!;

  // If this is an "off" phase (level === null), only stay active for 30 min
  // to avoid repeatedly turning off the bed hours later
  if (best.level === null) {
    const offEnd = new Date(best.startTime.getTime() + 30 * 60 * 1000);
    if (userNow >= best.startTime && userNow < offEnd) {
      return { level: null, isActive: true, phaseStartTime: best.startTime };
    }
    return { level: null, isActive: false, phaseStartTime: null };
  }

  return { level: best.level, isActive: true, phaseStartTime: best.startTime };
}

interface TestMode {
  enabled: boolean;
  currentTime: Date;
}

export async function adjustTemperature(testMode?: TestMode): Promise<void> {
  try {
    const profiles = await db
      .select()
      .from(userTemperatureProfile)
      .innerJoin(users, eq(userTemperatureProfile.email, users.email));

    for (const profile of profiles) {
      try {
        let token: Token = {
          eightAccessToken: profile.users.eightAccessToken,
          eightRefreshToken: profile.users.eightRefreshToken,
          eightExpiresAtPosix: profile.users.eightTokenExpiresAt.getTime(),
          eightUserId: profile.users.eightUserId,
        };

        const now = testMode?.enabled ? testMode.currentTime : new Date();

        if (!testMode?.enabled && now.getTime() > token.eightExpiresAtPosix) {
          token = await obtainFreshAccessToken(
            token.eightRefreshToken,
            token.eightUserId,
          );
          await db
            .update(users)
            .set({
              eightAccessToken: token.eightAccessToken,
              eightRefreshToken: token.eightRefreshToken,
              eightTokenExpiresAt: new Date(token.eightExpiresAtPosix),
            })
            .where(eq(users.email, profile.users.email));
        }

        const tempProfile = profile.userTemperatureProfiles;
        const userNow = new Date(now.toLocaleString("en-US", { timeZone: tempProfile.timezoneTZ }));

        let heatingStatus;
        if (testMode?.enabled) {
          heatingStatus = { isHeating: false, heatingLevel: 0 };
          console.log(`[TEST MODE] Current time set to: ${userNow.toISOString()}`);
        } else {
          heatingStatus = await retryApiCall(() => getCurrentHeatingStatus(token));
        }

        // --- PREHEAT-ONLY MODE ---
        if (tempProfile.preheatOnly) {
          const preheatStart = createDateWithTime(userNow, tempProfile.preheatTime);
          const preheatActivationEnd = new Date(preheatStart.getTime() + 45 * 60 * 1000);

          const inActivationWindow = isInTimeWindow(userNow, preheatStart, preheatActivationEnd);

          if (inActivationWindow && !heatingStatus.isHeating) {
            const apiLevel = tempProfile.preheatLevel * 10;
            if (testMode?.enabled) {
              console.log(`[TEST MODE] Would activate preheat at level ${apiLevel} for user ${profile.users.email}`);
            } else {
              await retryApiCall(() => setPreheat(token, profile.users.eightUserId, apiLevel, 43200));
              console.log(`Preheat activated at level ${apiLevel} (raw ${tempProfile.preheatLevel}) for user ${profile.users.email}`);
            }
          } else {
            console.log(`Preheat-only: no action needed for user ${profile.users.email} (inWindow=${inActivationWindow}, isHeating=${heatingStatus.isHeating})`);
          }

          continue;
        }

        // --- SCHEDULE MODE (custom phase profiles) ---
        if (tempProfile.activeProfileId !== null && tempProfile.activeProfileId !== undefined) {
          const activeProfile = await db
            .select()
            .from(sleepProfiles)
            .where(eq(sleepProfiles.id, tempProfile.activeProfileId))
            .execute();

          if (activeProfile.length > 0 && activeProfile[0]!.phases.length > 0) {
            const phases = activeProfile[0]!.phases;
            const allowManualOverride = activeProfile[0]!.allowManualOverride;
            const { level, isActive } = getCurrentPhaseLevel(userNow, phases);

            // Check if schedule is currently overridden by manual off
            const OVERRIDE_EXPIRY_MS = 18 * 60 * 60 * 1000; // 18 hours safety reset
            const isOverridden = allowManualOverride
              && tempProfile.scheduleOverriddenAt !== null
              && (now.getTime() - tempProfile.scheduleOverriddenAt.getTime()) < OVERRIDE_EXPIRY_MS;

            console.log(`User ${profile.users.email}: time=${userNow.toISOString()}, activeProfile="${activeProfile[0]!.name}", phaseLevel=${level ?? "off"}, isActive=${isActive}, isHeating=${heatingStatus.isHeating}, manualOverride=${allowManualOverride}, overridden=${isOverridden}, lastHeatingSet=${tempProfile.lastHeatingSetAt?.toISOString() ?? "never"}`);

            if (isActive) {
              if (level === null) {
                // Off phase: turn off the bed and clear all override flags (resets for next cycle)
                if (!testMode?.enabled) {
                  await db
                    .update(userTemperatureProfile)
                    .set({ scheduleOverriddenAt: null, lastHeatingSetAt: null, lastHeatingSetLevel: null, manualLevelOverrideAt: null })
                    .where(eq(userTemperatureProfile.email, profile.users.email));
                }
                if (heatingStatus.isHeating) {
                  if (testMode?.enabled) {
                    console.log(`[TEST MODE] Would turn off heating (off phase) for user ${profile.users.email}`);
                  } else {
                    await retryApiCall(() => turnOffSide(token, profile.users.eightUserId));
                    console.log(`Turned off heating (off phase) for user ${profile.users.email}`);
                  }
                } else {
                  console.log(`Off phase, bed already off. All flags cleared for user ${profile.users.email}`);
                }
              } else if (isOverridden) {
                // Schedule was manually overridden (bed turned off) — skip all heating until "off" phase clears it
                console.log(`Manual off override active — skipping heating for user ${profile.users.email}`);
              } else if (!heatingStatus.isHeating) {
                // Bed is off during a heating phase
                const cronPreviouslyActivated = tempProfile.lastHeatingSetAt !== null;

                if (allowManualOverride && cronPreviouslyActivated) {
                  // Cron previously turned it on, now it's off → manual off detected
                  if (!testMode?.enabled) {
                    await db
                      .update(userTemperatureProfile)
                      .set({ scheduleOverriddenAt: now })
                      .where(eq(userTemperatureProfile.email, profile.users.email));
                  }
                  console.log(`Manual off detected — setting override flag for user ${profile.users.email}`);
                } else {
                  // First activation of the cycle — turn on
                  if (testMode?.enabled) {
                    console.log(`[TEST MODE] Would set heating to level ${level} for user ${profile.users.email}`);
                  } else {
                    await retryApiCall(() => setPreheat(token, profile.users.eightUserId, level, 3600));
                    await db
                      .update(userTemperatureProfile)
                      .set({ lastHeatingSetAt: now, lastHeatingSetLevel: level, manualLevelOverrideAt: null })
                      .where(eq(userTemperatureProfile.email, profile.users.email));
                    console.log(`Set heating to level ${level} for user ${profile.users.email}`);
                  }
                }
              } else if (heatingStatus.heatingLevel !== level) {
                // Bed is on but at a different level than the phase wants
                const LEVEL_OVERRIDE_DURATION_MS = 90 * 60 * 1000;
                const hasLevelOverride = tempProfile.manualLevelOverrideAt !== null;
                const levelOverrideActive = hasLevelOverride
                  && (now.getTime() - tempProfile.manualLevelOverrideAt!.getTime()) < LEVEL_OVERRIDE_DURATION_MS;
                const isNewPhase = tempProfile.lastHeatingSetLevel !== level;

                if (levelOverrideActive) {
                  // Within 90 min of manual tweak — always respect
                  console.log(`Manual level tweak protected (${Math.round((now.getTime() - tempProfile.manualLevelOverrideAt!.getTime()) / 60000)}min of 90min) for user ${profile.users.email}`);
                } else if (hasLevelOverride && !isNewPhase) {
                  // Override expired but still same phase — keep respecting
                  console.log(`Manual level tweak respected (same phase, override expired) for user ${profile.users.email}`);
                } else if (hasLevelOverride && isNewPhase) {
                  // Override expired and new phase — apply new level
                  if (testMode?.enabled) {
                    console.log(`[TEST MODE] Would set heating to level ${level} (phase transition after override) for user ${profile.users.email}`);
                  } else {
                    await retryApiCall(() => setPreheat(token, profile.users.eightUserId, level, 3600));
                    await db
                      .update(userTemperatureProfile)
                      .set({ lastHeatingSetAt: now, lastHeatingSetLevel: level, manualLevelOverrideAt: null })
                      .where(eq(userTemperatureProfile.email, profile.users.email));
                    console.log(`Set heating to level ${level} (phase transition after override) for user ${profile.users.email}`);
                  }
                } else if (allowManualOverride && tempProfile.lastHeatingSetLevel === level) {
                  // Cron previously set this phase's level but it's now different → user tweaked
                  if (!testMode?.enabled) {
                    await db
                      .update(userTemperatureProfile)
                      .set({ manualLevelOverrideAt: now })
                      .where(eq(userTemperatureProfile.email, profile.users.email));
                  }
                  console.log(`Manual level tweak detected — protecting for 90min for user ${profile.users.email}`);
                } else {
                  // Phase transition or first activation — apply
                  if (testMode?.enabled) {
                    console.log(`[TEST MODE] Would set heating to level ${level} for user ${profile.users.email}`);
                  } else {
                    await retryApiCall(() => setPreheat(token, profile.users.eightUserId, level, 3600));
                    await db
                      .update(userTemperatureProfile)
                      .set({ lastHeatingSetAt: now, lastHeatingSetLevel: level, manualLevelOverrideAt: null })
                      .where(eq(userTemperatureProfile.email, profile.users.email));
                    console.log(`Set heating to level ${level} for user ${profile.users.email}`);
                  }
                }
              } else {
                console.log(`Heating already at correct level ${level} for user ${profile.users.email}`);
              }
            } else {
              console.log(`Schedule inactive for user ${profile.users.email}`);
            }
          } else {
            console.log(`No active profile or empty phases for user ${profile.users.email}`);
          }
        }

        console.log(`Successfully completed temperature adjustment check for user ${profile.users.email}`);
      } catch (error) {
        console.error(`Error adjusting temperature for user ${profile.users.email}:`, error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    console.error("Error fetching user profiles:", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const testTimeParam = searchParams.get("testTime");

    if (testTimeParam) {
      const testTime = new Date(Number(testTimeParam) * 1000);
      if (isNaN(testTime.getTime())) {
        throw new Error("Invalid testTime parameter");
      }
      console.log(
        `[TEST MODE] Running temperature adjustment cron job with test time: ${testTime.toISOString()}`,
      );
      await adjustTemperature({ enabled: true, currentTime: testTime });
    } else {
      await adjustTemperature();
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error(
      "Error in temperature adjustment cron job:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response("Internal server error", { status: 500 });
  }
}
