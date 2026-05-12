import { pgEnum } from "drizzle-orm/pg-core";

export const weightClassEnum = pgEnum("weight_class", [
  "strawweight",
  "flyweight",
  "bantamweight",
  "featherweight",
  "lightweight",
  "welterweight",
  "middleweight",
  "light_heavyweight",
  "heavyweight",
  "catchweight",
  "openweight",
]);

export const stanceEnum = pgEnum("stance", [
  "orthodox",
  "southpaw",
  "switch",
  "sideways",
  "unknown",
]);

export const fighterStatusEnum = pgEnum("fighter_status", [
  "active",
  "retired",
  "inactive",
  "suspended",
]);

export const promotionEnum = pgEnum("promotion", [
  "ufc",
  "bellator",
  "pfl",
  "one",
  "rizin",
  "aca",
  "cage_warriors",
  "ksw",
  "other",
]);

export const eventStatusEnum = pgEnum("event_status", [
  "upcoming",
  "in_progress",
  "completed",
  "cancelled",
  "postponed",
]);

export const boutMethodEnum = pgEnum("bout_method", [
  "ko",
  "tko",
  "submission",
  "decision_unanimous",
  "decision_split",
  "decision_majority",
  "draw",
  "no_contest",
  "dq",
]);

export const boutStatusEnum = pgEnum("bout_status", [
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
  "no_contest",
]);

export const userTierEnum = pgEnum("user_tier", [
  "bronze",
  "silver",
  "gold",
  "diamond",
  "champion",
]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "signup_bonus",
  "daily_bonus",
  "bet_placed",
  "bet_won",
  "bet_refunded",
  "achievement",
  "admin_adjustment",
]);

export const marketTypeEnum = pgEnum("market_type", [
  "winner",
  "method",
  "round",
  "distance",
  "prop",
]);

export const marketStatusEnum = pgEnum("market_status", [
  "open",
  "closed",
  "resolved",
  "cancelled",
]);

export const newsClassificationEnum = pgEnum("news_classification", [
  "bout_announced",
  "bout_cancelled",
  "bout_changed",
  "weigh_in",
  "result",
  "general_news",
  "rumor",
  "unrelated",
]);

export const newsStatusEnum = pgEnum("news_status", [
  "pending",
  "approved",
  "auto_approved",
  "rejected",
]);
