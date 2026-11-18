import { PrismaTransaction } from '../prisma.service';
import type { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { DraftIntakeRepository } from './draft.intake.repository';
import { DraftIntakeService } from './draft.intake.service';

const key = 'studio-export-001';
const manifest = 'a'.repeat(64);
const mediaPath = '/uploads/2026/11/19/synthetic.mp4';

function body(): CreatePostDto {
  return {
    type: 'draft',
    date: '2026-11-19T12:00:00.000Z',
    shortLink: false,
    tags: [],
    posts: [
      {
        type: 'draft',
        integration: { id: 'fixture-integration' },
        value: [
          {
            content: '<p>Synthetic caption</p>',
            image: [{ id: 'fixture-media', path: mediaPath }],
          },
        ],
      },
    ],
  } as CreatePostDto;
}

function fixture() {
  const receiptCreate = jest.fn().mockResolvedValue({ count: 1 });
  const receiptRead = jest.fn();
  const integrationRead = jest
    .fn()
    .mockResolvedValue({
      id: 'fixture-integration',
      providerIdentifier: 'fixture-provider',
    });
  const mediaRead = jest
    .fn()
    .mockResolvedValue({ id: 'fixture-media', path: mediaPath });
  const postCreate = jest
    .fn()
    .mockImplementation(async ({ data }) => ({ id: data.id }));
  const transaction = jest.fn().mockImplementation((callback) =>
    callback({
      draftIntakeReceipt: {
        createMany: receiptCreate,
        findUniqueOrThrow: receiptRead,
      },
      integration: { findFirst: integrationRead },
      media: { findFirst: mediaRead },
      post: { create: postCreate },
    })
  );
  const repository = new DraftIntakeRepository({
    model: { $transaction: transaction },
  } as unknown as PrismaTransaction);
  return {
    service: new DraftIntakeService(repository),
    receiptCreate,
    receiptRead,
    integrationRead,
    mediaRead,
    postCreate,
    transaction,
  };
}

it('claims a tenant receipt for one unpublished draft referencing its own uploaded media', async () => {
  const f = fixture();
  const [created] = await f.service.createScopedDraft(
    'workspace-a',
    key,
    body(),
    'CLI',
    manifest
  );

  expect(created).toEqual({
    postId: expect.any(String),
    integration: 'fixture-integration',
  });
  expect(f.transaction).toHaveBeenCalledTimes(1);
  expect(f.receiptCreate).toHaveBeenCalledWith({
    skipDuplicates: true,
    data: expect.objectContaining({
      organizationId: 'workspace-a',
      key,
      postId: created.postId,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  });
  expect(f.integrationRead).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        organizationId: 'workspace-a',
        disabled: false,
        deletedAt: null,
      }),
    })
  );
  expect(f.mediaRead).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        organizationId: 'workspace-a',
        deletedAt: null,
        status: 'ready',
      }),
    })
  );
  expect(f.postCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        id: created.postId,
        organization: { connect: { id: 'workspace-a' } },
        integration: {
          connect: expect.objectContaining({
            id: 'fixture-integration',
            organizationId: 'workspace-a',
          }),
        },
        state: 'DRAFT',
        image: JSON.stringify([{ id: 'fixture-media', path: mediaPath }]),
      }),
    })
  );
});

it('replays the committed receipt after a retry without creating another draft', async () => {
  const f = fixture();
  const first = await f.service.createScopedDraft(
    'workspace-a',
    key,
    body(),
    'CLI',
    manifest
  );
  const committed = f.receiptCreate.mock.calls[0][0].data;
  f.receiptCreate.mockResolvedValueOnce({ count: 0 });
  f.receiptRead.mockResolvedValueOnce(committed);

  expect(
    await f.service.createScopedDraft(
      'workspace-a',
      key,
      body(),
      'CLI',
      manifest
    )
  ).toEqual(first);
  expect(f.receiptRead).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { organizationId_key: { organizationId: 'workspace-a', key } },
    })
  );
  expect(f.postCreate).toHaveBeenCalledTimes(1);
});

it('rejects a different caption and a different reviewed manifest for the same key', async () => {
  const f = fixture();
  await f.service.createScopedDraft(
    'workspace-a',
    key,
    body(),
    'CLI',
    manifest
  );
  const committed = f.receiptCreate.mock.calls[0][0].data;
  f.receiptCreate.mockResolvedValue({ count: 0 });
  f.receiptRead.mockResolvedValue(committed);

  const changed = body();
  changed.posts[0].value[0].content = '<p>Changed caption</p>';
  await expect(
    f.service.createScopedDraft('workspace-a', key, changed, 'CLI', manifest)
  ).rejects.toThrow('different');
  await expect(
    f.service.createScopedDraft(
      'workspace-a',
      key,
      body(),
      'CLI',
      'b'.repeat(64)
    )
  ).rejects.toThrow('different');
  expect(f.postCreate).toHaveBeenCalledTimes(1);
});

it('rejects an attachment identity or path not owned by the authenticated workspace', async () => {
  const f = fixture();
  f.mediaRead.mockResolvedValueOnce(null);
  await expect(
    f.service.createScopedDraft('workspace-b', key, body(), 'CLI', manifest)
  ).rejects.toThrow('Media');
  f.mediaRead.mockResolvedValueOnce({
    id: 'fixture-media',
    path: '/other.mp4',
  });
  await expect(
    f.service.createScopedDraft('workspace-a', key, body(), 'CLI', manifest)
  ).rejects.toThrow('Media');
  expect(f.postCreate).not.toHaveBeenCalled();
});

it('requires a bounded key and reviewed manifest and rejects scheduled or edited posts', async () => {
  const f = fixture();
  const scheduled = { ...body(), type: 'schedule' } as CreatePostDto;
  const edited = body();
  edited.posts[0].value[0].id = 'existing-post';

  await expect(
    f.service.createScopedDraft(
      'workspace-a',
      undefined,
      body(),
      'CLI',
      manifest
    )
  ).rejects.toThrow('Idempotency-Key');
  await expect(
    f.service.createScopedDraft(
      'workspace-a',
      'x'.repeat(129),
      body(),
      'CLI',
      manifest
    )
  ).rejects.toThrow('Idempotency-Key');
  await expect(
    f.service.createScopedDraft('workspace-a', key, body(), 'CLI', undefined)
  ).rejects.toThrow('manifest');
  await expect(
    f.service.createScopedDraft('workspace-a', key, scheduled, 'CLI', manifest)
  ).rejects.toThrow('new draft');
  await expect(
    f.service.createScopedDraft('workspace-a', key, edited, 'CLI', manifest)
  ).rejects.toThrow('new draft');
  expect(f.transaction).not.toHaveBeenCalled();
});
