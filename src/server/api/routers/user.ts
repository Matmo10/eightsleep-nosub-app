import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { users, userTemperatureProfile, sleepProfiles } from "~/server/db/schema";
import { cookies } from "next/headers";
import {
  authenticate,
  obtainFreshAccessToken,
  AuthError,
} from "~/server/eight/auth";
import { eq, and } from "drizzle-orm";
import { type Token } from "~/server/eight/types";
import { TRPCError } from "@trpc/server";
import { adjustTemperature } from "~/app/api/temperatureCron/route";
import jwt from "jsonwebtoken";

class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

const checkAuthCookie = async (headers: Headers) => {
  const cookies = headers.get("cookie");
  console.log("Checking cookies");
  if (!cookies) {
    throw new AuthError(`Auth request failed. No cookies found.`, 401);
  }

  const token = cookies
    .split("; ")
    .find((row) => row.startsWith("8slpAutht="))
    ?.split("=")[1];
  console.log("Token:", token);

  if (!token) {
    throw new AuthError(`Auth request failed. No cookies found.`, 401);
  }
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      email: string;
    };
  } catch {
    throw new AuthError(`Auth request failed. Invalid token.`, 401);
  }

  return decoded;
};

const phaseSchema = z.object({
  time: z.string().regex(/^\d{2}:\d{2}$/),
  level: z.number().int().min(-100).max(100).nullable(),
});

export const userRouter = createTRPCRouter({
  checkLoginState: publicProcedure.query(async ({ ctx }) => {
    try {
      let decoded;
      try {
        decoded = await checkAuthCookie(ctx.headers);
      } catch (error) {
        if (error instanceof AuthError) {
          return { loginRequired: true };
        }
        throw error;
      }
      const email = decoded.email;

      const userList = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .execute();

      if (userList.length !== 1 || userList[0] === undefined) {
        return { loginRequired: true };
      }

      const user = userList[0];

      // check if token is expired, and if so, refresh it
      if (user.eightTokenExpiresAt < new Date()) {
        console.log("Token expired, refreshing for user", user.email);
        try {
          const {
            eightAccessToken,
            eightRefreshToken,
            eightExpiresAtPosix: expiresAt,
          } = await obtainFreshAccessToken(
            user.eightRefreshToken,
            user.eightUserId,
          );

          await db
            .update(users)
            .set({
              eightAccessToken,
              eightRefreshToken,
              eightTokenExpiresAt: new Date(expiresAt),
            })
            .where(eq(users.email, email))
            .execute();

          return { loginRequired: false };
        } catch (error) {
          console.error("Token renewal failed:", error);
          return { loginRequired: true };
        }
      }
      return { loginRequired: false };
    } catch (error) {
      console.error("Error in checkLoginState:", error);
      throw new Error(
        "An unexpected error occurred while checking login state.",
      );
    }
  }),

  login: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const authResult = await authenticateUser(input.email, input.password);

        const approvedEmails = process.env.APPROVED_EMAILS!.split(",").map(email => email.toLowerCase());

        if (!approvedEmails.includes(input.email.toLowerCase())) {
          throw new AuthError("Email not approved");
        }

        await saveUserToDatabase(input.email, authResult);

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
          throw new Error("JWT_SECRET is not defined in the environment");
        }

        const token = jwt.sign({ email: input.email }, jwtSecret, {
          expiresIn: "90d",
        });
        const threeMonthsInSeconds = 90 * 24 * 60 * 60; // 90 days

        cookies().set("8slpAutht", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: threeMonthsInSeconds,
          path: "/",
        });
        console.log("Saving token to cookie.");

        // Set HTTP-only cookie
        return {
          success: true,
        };
      } catch (error) {
        console.error("Error in login process:", error);
        if (error instanceof AuthError) {
          throw new Error(`Authentication failed: ${error.message}`);
        } else if (error instanceof DatabaseError) {
          throw new Error(
            "Failed to save login information. Please try again.",
          );
        } else {
          throw new Error(
            "An unexpected error occurred. Please try again later.",
          );
        }
      }
    }),
  logout: publicProcedure.mutation(async () => {
    try {
      cookies().set("8slpAutht", "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 0,
        path: "/",
      });
      return {
        success: true,
      };
    } catch (error) {
      console.error("Error during logout:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred during logout.",
      });
    }
  }),

  getUserTemperatureProfile: publicProcedure.query(async ({ ctx }) => {
    try {
      const decoded = await checkAuthCookie(ctx.headers);

      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, decoded.email),
      });

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Temperature profile not found for this user.",
        });
      }

      return profile;
    } catch (error) {
      console.error("Error fetching user temperature profile:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "An unexpected error occurred while fetching the temperature profile.",
      });
    }
  }),

  updateUserTemperatureProfile: publicProcedure
    .input(
      z.object({
        timezoneTZ: z.string().max(50),
        preheatTime: z.string().time(),
        preheatLevel: z.number().int().min(-10).max(10),
        preheatOnly: z.boolean(),
        activeProfileId: z.number().int().nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const decoded = await checkAuthCookie(ctx.headers);

        await db
          .insert(userTemperatureProfile)
          .values({
            email: decoded.email,
            timezoneTZ: input.timezoneTZ,
            preheatTime: input.preheatTime,
            preheatLevel: input.preheatLevel,
            preheatOnly: input.preheatOnly,
            activeProfileId: input.activeProfileId,
            // Old columns need defaults for the NOT NULL constraint
            bedTime: "22:00",
            wakeupTime: "06:00",
            initialSleepLevel: 0,
            midStageSleepLevel: 0,
            finalSleepLevel: 0,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: userTemperatureProfile.email,
            set: {
              timezoneTZ: input.timezoneTZ,
              preheatTime: input.preheatTime,
              preheatLevel: input.preheatLevel,
              preheatOnly: input.preheatOnly,
              activeProfileId: input.activeProfileId,
              updatedAt: new Date(),
            },
          })
          .execute();

        await adjustTemperature();

        return { success: true };
      } catch (error) {
        console.error("Error updating user temperature profile:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "An unexpected error occurred while updating the temperature profile.",
        });
      }
    }),

  deleteUserTemperatureProfile: publicProcedure.mutation(async ({ ctx }) => {
    try {
      const decoded = await checkAuthCookie(ctx.headers);
      const email = decoded.email;

      // Delete all sleep profiles first
      await db
        .delete(sleepProfiles)
        .where(eq(sleepProfiles.email, email))
        .execute();

      // Delete user temperature profile
      const result = await db
        .delete(userTemperatureProfile)
        .where(eq(userTemperatureProfile.email, email))
        .execute();

      if (result.rowCount === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Temperature profile not found for this user.",
        });
      }

      return {
        success: true,
        message: "User temperature profile deleted successfully",
      };
    } catch (error) {
      console.error("Error deleting user temperature profile:", error);
      if (error instanceof TRPCError) {
        throw error;
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "An unexpected error occurred while deleting the user temperature profile.",
      });
    }
  }),

  // --- Sleep Profile CRUD ---

  getSleepProfiles: publicProcedure.query(async ({ ctx }) => {
    const decoded = await checkAuthCookie(ctx.headers);
    return db
      .select()
      .from(sleepProfiles)
      .where(eq(sleepProfiles.email, decoded.email))
      .execute();
  }),

  createSleepProfile: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        phases: z.array(phaseSchema).min(1),
        allowManualOverride: z.boolean().optional().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      const [newProfile] = await db
        .insert(sleepProfiles)
        .values({
          email: decoded.email,
          name: input.name,
          phases: input.phases,
          allowManualOverride: input.allowManualOverride,
        })
        .returning();
      return newProfile!;
    }),

  updateSleepProfile: publicProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().min(1).max(100),
        phases: z.array(phaseSchema).min(1),
        allowManualOverride: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      const existing = await db
        .select()
        .from(sleepProfiles)
        .where(and(eq(sleepProfiles.id, input.id), eq(sleepProfiles.email, decoded.email)))
        .execute();

      if (existing.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
      }

      await db
        .update(sleepProfiles)
        .set({
          name: input.name,
          phases: input.phases,
          allowManualOverride: input.allowManualOverride,
          updatedAt: new Date(),
        })
        .where(eq(sleepProfiles.id, input.id))
        .execute();

      await adjustTemperature();
      return { success: true };
    }),

  deleteSleepProfile: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const decoded = await checkAuthCookie(ctx.headers);
      const existing = await db
        .select()
        .from(sleepProfiles)
        .where(and(eq(sleepProfiles.id, input.id), eq(sleepProfiles.email, decoded.email)))
        .execute();

      if (existing.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
      }

      // Clear activeProfileId if this was the active profile
      const settings = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, decoded.email),
      });
      if (settings?.activeProfileId === input.id) {
        await db
          .update(userTemperatureProfile)
          .set({ activeProfileId: null, updatedAt: new Date() })
          .where(eq(userTemperatureProfile.email, decoded.email))
          .execute();
      }

      await db
        .delete(sleepProfiles)
        .where(eq(sleepProfiles.id, input.id))
        .execute();

      return { success: true };
    }),

  setActiveProfile: publicProcedure
    .input(z.object({ profileId: z.number().int().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const decoded = await checkAuthCookie(ctx.headers);

      // Verify profile belongs to user if non-null
      if (input.profileId !== null) {
        const profile = await db
          .select()
          .from(sleepProfiles)
          .where(and(eq(sleepProfiles.id, input.profileId), eq(sleepProfiles.email, decoded.email)))
          .execute();
        if (profile.length === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
        }
      }

      await db
        .update(userTemperatureProfile)
        .set({
          activeProfileId: input.profileId,
          preheatOnly: input.profileId === null,
          updatedAt: new Date(),
        })
        .where(eq(userTemperatureProfile.email, decoded.email))
        .execute();

      await adjustTemperature();
      return { success: true };
    }),
});

async function authenticateUser(email: string, password: string) {
  try {
    return await authenticate(email, password);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error; // Propagate the AuthError with its specific message
    } else {
      throw new AuthError("Failed to authenticate user");
    }
  }
}

async function saveUserToDatabase(email: string, authResult: Token) {
  try {
    await db
      .insert(users)
      .values({
        email,
        eightAccessToken: authResult.eightAccessToken,
        eightRefreshToken: authResult.eightRefreshToken,
        eightTokenExpiresAt: new Date(authResult.eightExpiresAtPosix),
        eightUserId: authResult.eightUserId,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          eightAccessToken: authResult.eightAccessToken,
          eightRefreshToken: authResult.eightRefreshToken,
          eightTokenExpiresAt: new Date(authResult.eightExpiresAtPosix),
          eightUserId: authResult.eightUserId,
        },
      })
      .execute();
  } catch (error) {
    console.error("Database operation failed:", error);
    throw new DatabaseError("Failed to save user token to database.");
  }
}
