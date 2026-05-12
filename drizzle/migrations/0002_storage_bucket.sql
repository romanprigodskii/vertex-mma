-- Run manually in Supabase SQL Editor before the photo scraper writes anything.
-- Creates the public bucket and a SELECT policy so client code can read photos.

INSERT INTO storage.buckets (id, name, public)
VALUES ('fighter-photos', 'fighter-photos', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Public read fighter photos'
  ) THEN
    CREATE POLICY "Public read fighter photos"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'fighter-photos');
  END IF;
END $$;
