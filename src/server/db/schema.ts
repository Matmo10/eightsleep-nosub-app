import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTableCreator,
  serial,
  text,
  time,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const createTable = pgTableCreator((name) => `8slp_${name}`); // also in drizzle.config.ts

export const users = createTable("users", {
  email: varchar("email", { length: 255 }).notNull().primaryKey(),
  eightUserId: varchar("eightUserId", { length: 255 }).notNull(),
  eightAccessToken: text("access_token").notNull(),
  eightRefreshToken: text("refresh_token").notNull(),
  eightTokenExpiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userTemperatureProfile = createTable("userTemperatureProfiles", {
  email: varchar('email', { length: 255 }).references(() => users.email).primaryKey(),
  // Old fixed-cycle columns (kept for data preservation, unused by new code)
  bedTime: time("bedTime").notNull(),
  wakeupTime: time("wakeupTime").notNull(),
  initialSleepLevel: integer("initialSleepLevel").notNull(),
  midStageSleepLevel: integer("midStageSleepLevel").notNull(),
  finalSleepLevel: integer("finalSleepLevel").notNull(),
  cycleEnabled: boolean("cycleEnabled").notNull().default(true),
  // Active columns
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  timezoneTZ: varchar("timezone", { length: 50 }).notNull(),
  preheatTime: time("preheatTime").notNull().default("21:00"),
  preheatLevel: integer("preheatLevel").notNull().default(10),
  preheatOnly: boolean("preheatOnly").notNull().default(false),
  activeProfileId: integer("activeProfileId"),
});

export interface SleepPhase {
  time: string;        // "HH:MM" format
  level: number | null; // -100 to 100 (API scale), null = turn off
}

export const sleepProfiles = createTable("sleepProfiles", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  phases: jsonb("phases").$type<SleepPhase[]>().notNull(),
  allowManualOverride: boolean("allowManualOverride").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  temperatureProfile: one(userTemperatureProfile, {
    fields: [users.email],
    references: [userTemperatureProfile.email],
  }),
  sleepProfiles: many(sleepProfiles),
}));

export const userTemperatureProfileRelations = relations(userTemperatureProfile, ({ one }) => ({
  user: one(users, {
    fields: [userTemperatureProfile.email],
    references: [users.email],
  }),
}));

export const sleepProfilesRelations = relations(sleepProfiles, ({ one }) => ({
  user: one(users, {
    fields: [sleepProfiles.email],
    references: [users.email],
  }),
}));
