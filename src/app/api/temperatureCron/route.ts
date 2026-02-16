import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile, users } from "~/server/db/schema";
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
 * For example, if start=21:00 and end=06:00, times from 21:00-23:59 and 00:00-05:59 are "in range".
 */
function isInTimeWindow(now: Date, start: Date, end: Date): boolean {
  if (start <= end) {
    // Same-day window (e.g., 09:00 to 11:00)
    return now >= start && now < end;
  } else {
    // Overnight window (e.g., 22:00 to 06:00)
    return now >= start || now < end;
  }
}

type SleepStage = "pre-heating" | "initial" | "mid" | "final" | "off" | "inactive";

interface StageResult {
  stage: SleepStage;
  targetLevel?: number;
}

/**
 * Determine the current sleep stage based on user's configured times.
 * Handles overnight sleep cycles (bedtime PM, wakeup AM).
 */
function getCurrentSleepStage(
  userNow: Date,
  bedTimeStr: string,
  wakeupTimeStr: string,
  initialLevel: number,
  midLevel: number,
  finalLevel: number,
): StageResult {
  const bedTime = createDateWithTime(userNow, bedTimeStr);
  let wakeupTime = createDateWithTime(userNow, wakeupTimeStr);

  // If wakeup is before bedtime, it's the next day
  if (wakeupTime <= bedTime) {
    wakeupTime = new Date(wakeupTime);
    wakeupTime.setDate(wakeupTime.getDate() + 1);
  }

  const preHeatStart = new Date(bedTime.getTime() - 60 * 60 * 1000); // 1h before bed
  const midStageStart = new Date(bedTime.getTime() + 60 * 60 * 1000); // 1h after bed
  const finalStageStart = new Date(wakeupTime.getTime() - 2 * 60 * 60 * 1000); // 2h before wake
  const offEnd = new Date(wakeupTime.getTime() + 30 * 60 * 1000); // 30min after wake

  // For overnight cycles, we need to check if userNow is in yesterday's cycle.
  // Try both "today's cycle" and "yesterday's cycle" (shifted back 24h).
  const offsets = [0, -24 * 60 * 60 * 1000];

  for (const offset of offsets) {
    const phs = new Date(preHeatStart.getTime() + offset);
    const bt = new Date(bedTime.getTime() + offset);
    const ms = new Date(midStageStart.getTime() + offset);
    const fs = new Date(finalStageStart.getTime() + offset);
    const wt = new Date(wakeupTime.getTime() + offset);
    const oe = new Date(offEnd.getTime() + offset);

    if (userNow >= phs && userNow < bt) {
      return { stage: "pre-heating", targetLevel: initialLevel };
    }
    if (userNow >= bt && userNow < ms) {
      return { stage: "initial", targetLevel: initialLevel };
    }
    if (userNow >= ms && userNow < fs) {
      return { stage: "mid", targetLevel: midLevel };
    }
    if (userNow >= fs && userNow < wt) {
      return { stage: "final", targetLevel: finalLevel };
    }
    if (userNow >= wt && userNow < oe) {
      return { stage: "off" };
    }
  }

  return { stage: "inactive" };
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
          const preheatActivationEnd = new Date(preheatStart.getTime() + 45 * 60 * 1000); // 45-min activation window

          const inActivationWindow = isInTimeWindow(userNow, preheatStart, preheatActivationEnd);

          if (inActivationWindow && !heatingStatus.isHeating) {
            // Activate preheat: set once with 12-hour duration, then hands off
            const apiLevel = tempProfile.preheatLevel * 10; // Scale -10..10 to -100..100 for API
            if (testMode?.enabled) {
              console.log(`[TEST MODE] Would activate preheat at level ${apiLevel} for user ${profile.users.email}`);
            } else {
              await retryApiCall(() => setPreheat(token, profile.users.eightUserId, apiLevel, 43200)); // 12 hours
              console.log(`Preheat activated at level ${apiLevel} (raw ${tempProfile.preheatLevel}) for user ${profile.users.email}`);
            }
          } else {
            console.log(`Preheat-only: no action needed for user ${profile.users.email} (inWindow=${inActivationWindow}, isHeating=${heatingStatus.isHeating})`);
          }

          continue; // Skip sleep cycle logic
        }

        // --- SLEEP CYCLE MODE ---
        if (tempProfile.cycleEnabled) {
          const { stage, targetLevel } = getCurrentSleepStage(
            userNow,
            tempProfile.bedTime,
            tempProfile.wakeupTime,
            tempProfile.initialSleepLevel,
            tempProfile.midStageSleepLevel,
            tempProfile.finalSleepLevel,
          );

          console.log(`User ${profile.users.email}: time=${userNow.toISOString()}, stage=${stage}, targetLevel=${targetLevel ?? "n/a"}, currentLevel=${heatingStatus.heatingLevel}, isHeating=${heatingStatus.isHeating}`);

          if (stage !== "inactive" && stage !== "off" && targetLevel !== undefined) {
            // Active sleep stage: ensure bed is at the correct temperature
            if (!heatingStatus.isHeating || heatingStatus.heatingLevel !== targetLevel) {
              if (testMode?.enabled) {
                console.log(`[TEST MODE] Would set heating to level ${targetLevel} for stage "${stage}" for user ${profile.users.email}`);
              } else {
                await retryApiCall(() => setPreheat(token, profile.users.eightUserId, targetLevel, 3600)); // 1h, refreshed each cron
                console.log(`Set heating to level ${targetLevel} for stage "${stage}" for user ${profile.users.email}`);
              }
            } else {
              console.log(`Heating already at correct level ${targetLevel} for stage "${stage}" for user ${profile.users.email}`);
            }
          } else if (stage === "off" && heatingStatus.isHeating) {
            // Just past wakeup time: turn off the bed
            if (testMode?.enabled) {
              console.log(`[TEST MODE] Would turn off heating (wakeup) for user ${profile.users.email}`);
            } else {
              await retryApiCall(() => turnOffSide(token, profile.users.eightUserId));
              console.log(`Turned off heating (wakeup) for user ${profile.users.email}`);
            }
          } else {
            console.log(`No action needed for stage "${stage}" for user ${profile.users.email}`);
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
