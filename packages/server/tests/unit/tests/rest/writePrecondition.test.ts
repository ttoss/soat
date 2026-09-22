import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The precondition is exercised through guardrails because a guardrail's whole
 * config is one field: the version moves on a `document` write and on nothing
 * else, so "did this write take a version" is unambiguous. Every versioned
 * resource shares the engine, and `writePreconditionContract.test.ts` holds
 * them all to it.
 */
const GUARDRAIL_ACTIONS = [
  'guardrails:CreateGuardrail',
  'guardrails:GetGuardrail',
  'guardrails:UpdateGuardrail',
  'guardrails:ListGuardrailVersions',
];

const documentAllowing = (limit: number) => {
  return {
    default_class: 'C',
    class: { if: [{ '<': [{ var: 'args.amount' }, limit] }, 'B', 'C'] },
  };
};

describe('Write preconditions', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'writeprecond',
      policyActions: GUARDRAIL_ACTIONS,
      createNoPermUser: false,
    });

    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  /** A fresh guardrail at version 1, so each test owns its own counter. */
  const createGuardrail = async (name: string): Promise<string> => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name,
        document: documentAllowing(500),
      });

    expect(response.status).toBe(201);
    return response.body.id;
  };

  describe('expected_version on the body', () => {
    test('a write naming the current version is applied', async () => {
      const id = await createGuardrail('precond-match');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600), expected_version: 1 });

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(2);
    });

    test('a write naming a stale version is refused with the current one', async () => {
      const id = await createGuardrail('precond-stale');

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600) });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(700), expected_version: 1 });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('VERSION_CONFLICT');
      expect(response.body.error.meta.current_version).toBe(2);
      expect(response.body.error.meta.expected_version).toBe(1);
    });

    test('a refused write leaves the resource untouched', async () => {
      const id = await createGuardrail('precond-untouched');

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600) });

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({
          name: 'renamed-by-a-refused-write',
          document: documentAllowing(700),
          expected_version: 1,
        });

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${id}`
      );

      expect(after.body.version).toBe(2);
      expect(after.body.name).toBe('precond-untouched');
      expect(after.body.document).toEqual(documentAllowing(600));
    });

    test('a write changing nothing is accepted against its own version', async () => {
      const id = await createGuardrail('precond-noop');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(500), expected_version: 1 });

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(1);
    });

    test('a write changing nothing is still refused against a stale version', async () => {
      const id = await createGuardrail('precond-noop-stale');

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600) });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600), expected_version: 1 });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('VERSION_CONFLICT');
    });

    test('a non-integer version is rejected before the write', async () => {
      const id = await createGuardrail('precond-bad-field');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600), expected_version: 1.5 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
    test('a string version on the body is refused as the wrong type, without offering `*`', async () => {
      const id = await createGuardrail('precond-string-field');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600), expected_version: '1' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toContain('integer');
      expect(response.body.error.message).not.toContain("'*'");
    });
  });

  describe('If-Match on the request', () => {
    test('a bare version matching the current one is applied', async () => {
      const id = await createGuardrail('ifmatch-bare');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .set('If-Match', '1')
        .send({ document: documentAllowing(600) });

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(2);
    });

    test('a quoted entity tag names the same version', async () => {
      const id = await createGuardrail('ifmatch-quoted');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .set('If-Match', '"1"')
        .send({ document: documentAllowing(600) });

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(2);
    });

    test('a stale version is refused', async () => {
      const id = await createGuardrail('ifmatch-stale');

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600) });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .set('If-Match', '1')
        .send({ document: documentAllowing(700) });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('VERSION_CONFLICT');
      expect(response.body.error.meta.current_version).toBe(2);
    });

    test('`*` states no precondition beyond the resource existing', async () => {
      const id = await createGuardrail('ifmatch-any');

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600) });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .set('If-Match', '*')
        .send({ document: documentAllowing(700) });

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(3);
    });

    test('a header that is not a version is rejected', async () => {
      const id = await createGuardrail('ifmatch-garbage');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .set('If-Match', 'not-a-version')
        .send({ document: documentAllowing(600) });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a header contradicting the body is rejected', async () => {
      const id = await createGuardrail('ifmatch-contradiction');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .set('If-Match', '2')
        .send({ document: documentAllowing(600), expected_version: 1 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a header agreeing with the body is one precondition', async () => {
      const id = await createGuardrail('ifmatch-agreement');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .set('If-Match', '1')
        .send({ document: documentAllowing(600), expected_version: 1 });

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(2);
    });
  });

  describe('concurrent writes', () => {
    /**
     * Neither writer states a precondition, so nothing here opts in: this is
     * the guarantee a caller gets for free.
     *
     * Two requests sent together may still serialize, in which case both are
     * applied and both are correct — so what is asserted is the invariant that
     * holds either way: every write is applied or refused, never half-applied,
     * and the archive that results is a chain with no gap and no repeat. The
     * interleaving where one writer is overtaken mid-write is chosen
     * explicitly in `lib/resourceVersionStore.test.ts`, because two HTTP
     * requests cannot be made to overlap on demand.
     */
    test('racing writers leave an unbroken version chain', async () => {
      const id = await createGuardrail('precond-race');

      const responses = await Promise.all(
        [600, 700, 800, 900].map((limit) => {
          return authenticatedTestClient(userToken)
            .patch(`/api/v1/guardrails/${id}`)
            .send({ document: documentAllowing(limit) });
        })
      );

      const applied = responses.filter((response) => {
        return response.status === 200;
      });

      for (const response of responses) {
        if (response.status === 200) continue;
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('VERSION_CONFLICT');
      }

      expect(applied.length).toBeGreaterThan(0);

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${id}`
      );
      expect(after.body.version).toBe(applied.length + 1);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${id}/versions`
      );
      expect(
        versions.body.data
          .map((version: { version: number }) => {
            return version.version;
          })
          .sort((a: number, b: number) => {
            return a - b;
          })
      ).toEqual(
        Array.from({ length: applied.length + 1 }, (_unused, index) => {
          return index + 1;
        })
      );
    });

    /**
     * A refused write is refused whole: the document it carried must not be
     * the one the resource ends up holding.
     */
    test('a refused write never leaves its document behind', async () => {
      const id = await createGuardrail('precond-race-rollback');

      const stale = authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(999), expected_version: 1 });

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${id}`)
        .send({ document: documentAllowing(600) });

      await stale;

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${id}`
      );
      expect(after.body.document).not.toEqual(documentAllowing(999));
    });
  });
});
