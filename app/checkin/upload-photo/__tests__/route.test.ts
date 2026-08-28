/**
 * `T.7`'s photo upload Route Handler — mocks `@sovereignfs/sdk` the same
 * way `app/__tests__/actions.test.ts` does, since this route calls `sdk`
 * directly rather than through `_lib/authz.ts`/`_lib/db.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  currentUser: { id: 'user-1', tenantId: 'tenant-1' } as { id: string; tenantId: string } | null,
  putCalls: [] as unknown[],
}));

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    auth: {
      requireSession: vi.fn(async () => {
        if (!harness.currentUser) throw new Error('Not authenticated');
        return { user: harness.currentUser };
      }),
    },
    storage: {
      put: vi.fn(async (input: { key: string }) => {
        harness.putCalls.push(input);
        return { id: 'obj-1', key: input.key };
      }),
    },
  },
}));

import { POST } from '../route';

function requestWithFile(file: File | null): Request {
  const formData = new FormData();
  if (file) formData.set('file', file);
  return new Request('http://localhost/travellog/checkin/upload-photo', {
    method: 'POST',
    body: formData,
  });
}

describe('POST /checkin/upload-photo', () => {
  it('requires a session', async () => {
    harness.currentUser = null;
    await expect(POST(requestWithFile(new File(['x'], 'a.jpg', { type: 'image/jpeg' })))).rejects.toThrow();
    harness.currentUser = { id: 'user-1', tenantId: 'tenant-1' };
  });

  it('rejects a request with no file', async () => {
    const response = await POST(requestWithFile(null));
    expect(response.status).toBe(400);
  });

  it('rejects a non-image file', async () => {
    const response = await POST(requestWithFile(new File(['x'], 'a.txt', { type: 'text/plain' })));
    expect(response.status).toBe(400);
  });

  it('rejects an empty file', async () => {
    const response = await POST(requestWithFile(new File([], 'a.jpg', { type: 'image/jpeg' })));
    expect(response.status).toBe(400);
  });

  it('rejects a file over the size cap', async () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    const response = await POST(requestWithFile(new File([big], 'a.jpg', { type: 'image/jpeg' })));
    expect(response.status).toBe(400);
  });

  it('uploads a valid image and returns its storage key', async () => {
    harness.putCalls = [];
    const response = await POST(requestWithFile(new File(['x'], 'a.jpg', { type: 'image/jpeg' })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { storageKey: string };
    expect(body.storageKey).toMatch(/^visits\/user-1\//);
    expect(harness.putCalls).toHaveLength(1);
    expect(harness.putCalls[0]).toMatchObject({ contentType: 'image/jpeg', ownerUserId: 'user-1' });
  });
});
