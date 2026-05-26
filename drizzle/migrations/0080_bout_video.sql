-- bout_video: YouTube clips linked to bouts (free fights + highlights from
-- the official UFC channel). One bout can have multiple linked videos.

DO $$ BEGIN
  CREATE TYPE "public"."bout_video_kind" AS ENUM('free_fight', 'highlights');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "bout_video" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bout_id" uuid NOT NULL,
  "youtube_video_id" text NOT NULL,
  "kind" "bout_video_kind" NOT NULL,
  "title" text NOT NULL,
  "duration_seconds" integer,
  "published_at" timestamp with time zone,
  "thumbnail_url" text,
  "source_channel" text DEFAULT 'UFC' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bout_video_yt_unique" UNIQUE("bout_id", "youtube_video_id")
);

DO $$ BEGIN
  ALTER TABLE "bout_video"
    ADD CONSTRAINT "bout_video_bout_id_bout_id_fk"
    FOREIGN KEY ("bout_id") REFERENCES "public"."bout"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "bout_video_bout_idx" ON "bout_video" ("bout_id");
