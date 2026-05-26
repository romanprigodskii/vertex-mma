import Link from "next/link";

import { CommentComposer } from "@/components/news/news-comment-composer";
import { CommentItem } from "@/components/news/news-comment-item";
import {
  getCommentAuthor,
  listCommentsForNews,
} from "@/lib/news-comments";

export async function NewsComments({ newsItemId }: { newsItemId: string }) {
  const [{ comments, total }, currentUser] = await Promise.all([
    listCommentsForNews(newsItemId),
    getCommentAuthor(),
  ]);

  return (
    <section className="mt-14 border-t border-foreground/10 pt-8">
      <div className="mb-5 flex items-baseline justify-between gap-4">
        <h3 className="font-display text-2xl uppercase tracking-tight text-foreground">
          Comments{" "}
          <span className="ml-1 font-mono text-xs tracking-wider text-foreground-subtle">
            · {total}
          </span>
        </h3>
      </div>

      {currentUser ? (
        <CommentComposer
          newsItemId={newsItemId}
          parentId={null}
          author={currentUser}
        />
      ) : (
        <div className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-5 text-center">
          <p className="font-sans text-sm text-foreground-muted">
            <Link
              href={`/signin?next=/news/${newsItemId}`}
              prefetch={false}
              className="text-primary hover:underline"
            >
              Sign in
            </Link>{" "}
            to join the conversation.
          </p>
        </div>
      )}

      <div className="mt-7 flex flex-col gap-6">
        {comments.length === 0 ? (
          <p className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/20 px-4 py-10 text-center font-sans text-sm text-foreground-subtle">
            No comments yet — be the first to weigh in.
          </p>
        ) : (
          comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              newsItemId={newsItemId}
              currentAuthor={currentUser}
            />
          ))
        )}
      </div>
    </section>
  );
}
