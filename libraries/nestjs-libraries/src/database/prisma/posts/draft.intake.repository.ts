import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreationMethod, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaTransaction } from '../prisma.service';

export interface DraftIntakeInput {
  organizationId: string;
  key: string;
  requestHash: string;
  integrationId: string;
  publishDate: Date;
  content: string;
  media: { id: string; path: string };
  creationMethod: CreationMethod;
}

@Injectable()
export class DraftIntakeRepository {
  constructor(private readonly transaction: PrismaTransaction) {}

  create(input: DraftIntakeInput) {
    const { organizationId, key, requestHash, integrationId } = input;
    const postId = randomUUID();

    return this.transaction.model.$transaction(
      async (tx) => {
        // The receipt row is the concurrency gate. A failed write rolls it back
        // with the draft, so no pending lock survives an interruption.
        const claimed = await tx.draftIntakeReceipt.createMany({
          data: { organizationId, key, requestHash, postId, integrationId },
          skipDuplicates: true,
        });
        if (!claimed.count) {
          const previous = await tx.draftIntakeReceipt.findUniqueOrThrow({
            where: { organizationId_key: { organizationId, key } },
            select: { requestHash: true, postId: true, integrationId: true },
          });
          if (previous.requestHash !== requestHash) {
            throw new ConflictException(
              'Idempotency-Key was used for a different draft'
            );
          }
          return {
            postId: previous.postId,
            integration: previous.integrationId,
          };
        }

        const integrationMatch = {
          id: integrationId,
          organizationId,
          disabled: false,
          deletedAt: null,
          inBetweenSteps: false,
        };
        const integration = await tx.integration.findFirst({
          where: integrationMatch,
          select: { id: true, providerIdentifier: true },
        });
        if (!integration) {
          throw new NotFoundException('Draft integration not found');
        }

        const media = await tx.media.findFirst({
          where: {
            id: input.media.id,
            organizationId,
            deletedAt: null,
            status: 'ready',
          },
          select: { id: true, path: true },
        });
        if (!media || media.path !== input.media.path) {
          throw new NotFoundException('Media not found for the draft');
        }

        await tx.post.create({
          data: {
            id: postId,
            organization: { connect: { id: organizationId } },
            integration: { connect: integrationMatch },
            publishDate: input.publishDate,
            content: input.content,
            group: randomUUID(),
            batchId: randomUUID(),
            state: 'DRAFT',
            image: JSON.stringify([media]),
            settings: JSON.stringify({
              __type: integration.providerIdentifier,
            }),
            creationMethod: input.creationMethod,
          },
          select: { id: true },
        });

        return { postId, integration: integration.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }
}
