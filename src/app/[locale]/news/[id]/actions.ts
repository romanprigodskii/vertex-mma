"use server";

import {
  addNewsComment,
  flagComment,
  softDeleteComment,
  voteComment,
  type AddCommentResult,
} from "@/lib/news-comments";

export async function postCommentAction(input: {
  newsItemId: string;
  parentId: string | null;
  body: string;
}): Promise<AddCommentResult> {
  return addNewsComment(input);
}

export async function deleteCommentAction(input: { commentId: string }) {
  return softDeleteComment(input.commentId);
}

export async function reportCommentAction(input: {
  commentId: string;
  reason?: string;
}) {
  return flagComment(input.commentId, input.reason);
}

export async function voteCommentAction(input: {
  commentId: string;
  dir: 1 | -1;
}) {
  return voteComment(input.commentId, input.dir);
}
