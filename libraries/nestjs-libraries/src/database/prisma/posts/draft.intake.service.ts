import { BadRequestException, Injectable } from '@nestjs/common';
import type { CreationMethod } from '@prisma/client';
import type { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { createHash } from 'node:crypto';
import { DraftIntakeRepository } from './draft.intake.repository';

@Injectable()
export class DraftIntakeService {
  constructor(private readonly repository: DraftIntakeRepository) {}

  async createScopedDraft(
    organizationId: string,
    key: unknown,
    body: CreatePostDto,
    creationMethod: CreationMethod,
    manifestSha256: unknown
  ) {
    if (
      typeof key !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)
    ) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }
    if (
      typeof manifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(manifestSha256)
    ) {
      throw new BadRequestException(
        'A reviewed draft manifest SHA-256 is required'
      );
    }

    const [post] = body.posts;
    const value = post?.value?.[0];
    const media = value?.image?.[0];
    const publishDate = new Date(body.date);
    if (
      body.type !== 'draft' ||
      body.shortLink !== false ||
      body.tags.length ||
      body.inter != null ||
      body.order != null ||
      body.republish != null ||
      body.posts.length !== 1 ||
      !post?.integration?.id ||
      (post.type != null && post.type !== 'draft') ||
      post.group != null ||
      post.date != null ||
      post.value?.length !== 1 ||
      !value?.content ||
      value.id != null ||
      (value.delay != null && value.delay !== 0) ||
      value.image.length !== 1 ||
      !media?.id ||
      !media.path ||
      !Number.isFinite(publishDate.valueOf())
    ) {
      throw new BadRequestException(
        'A scoped request must create one new draft'
      );
    }

    // Hash normalized fields in a fixed order rather than relying on a
    // caller's manifest digest alone or on JSON property order.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          manifestSha256,
          post.integration.id,
          publishDate.toISOString(),
          value.content,
          media.id,
          media.path,
          creationMethod,
        ])
      )
      .digest('hex');
    return [
      await this.repository.create({
        organizationId,
        key,
        requestHash,
        integrationId: post.integration.id,
        publishDate,
        content: value.content,
        media: { id: media.id, path: media.path },
        creationMethod,
      }),
    ];
  }
}
