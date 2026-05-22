import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    company: text("company"),
    source: text("source"),
    status: text("status").$type<"joined" | "invited" | "converted" | "archived">().notNull().default("joined"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("waitlist_entries_email_key").on(table.email)]
);

export const waitlistTriggers = pgTable("waitlist_triggers", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  entryId: text("entry_id").references(() => waitlistEntries.id),
  status: text("status").$type<"queued" | "processed" | "failed">().notNull().default("queued"),
  payloadJson: text("payload_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
});
