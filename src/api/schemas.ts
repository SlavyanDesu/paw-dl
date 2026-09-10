import { z } from 'zod';

const IdSchema = z.string().refine((value) => value.trim().length > 0, 'ID tidak boleh kosong.');

export const AttachmentSchema = z.object({
  name: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  path: z.string().min(1),
  deferred: z.boolean().default(false),
});

export type Attachment = z.infer<typeof AttachmentSchema>;

// Respons API bisa menyatakan file kosong sebagai null,
// undefined, {}, atau object dengan path kosong.
const OptionalAttachmentSchema = AttachmentSchema.extend({
  path: z.string().nullish(),
})
  .nullish()
  .transform((file): Attachment | null => {
    if (!file?.path) {
      return null;
    }

    return {
      name: file.name,
      path: file.path,
      deferred: file.deferred,
    };
  });

export const CreatorSchema = z.object({
  name: z.string().refine((value) => value.trim().length > 0, 'Nama kreator tidak boleh kosong.'),
});

export const PostSummarySchema = z.object({
  id: IdSchema,
});

export const PostSchema = z.object({
  id: IdSchema,
  title: z.string(),
  published: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  file: OptionalAttachmentSchema,
  attachments: z
    .array(OptionalAttachmentSchema)
    .transform((items) => items.filter((item): item is Attachment => item !== null)),
});

const PostResponseSchema = z.union([z.object({ post: PostSchema }).transform((value) => value.post), PostSchema]);

const PostListResponseSchema = z.union([
  z.array(PostSummarySchema),
  z.object({ posts: z.array(PostSummarySchema) }).transform((value) => value.posts),
]);

export type Creator = z.infer<typeof CreatorSchema>;
export type Post = z.infer<typeof PostSchema>;
export type PostSummary = z.infer<typeof PostSummarySchema>;

export function parseCreator(value: unknown): Creator {
  return CreatorSchema.parse(value);
}

export function parsePost(value: unknown): Post {
  return PostResponseSchema.parse(value);
}

export function parsePostList(value: unknown): PostSummary[] {
  return PostListResponseSchema.parse(value);
}
