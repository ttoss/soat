import { routes } from '../../../src/generated/routes';
import { createCliTestClient } from '../testClient';

/**
 * A tag route's body is the bag itself and names no property, so its flag
 * carries the whole body (`in: 'body-root'`) rather than one field of it.
 */
const tagBagCommands = Object.entries(routes)
  .filter(([, route]) => {
    return route.flags.some((flag) => {
      return flag.in === 'body-root';
    });
  })
  .map(([command]) => {
    return command;
  })
  .sort();

describe('a tag bag body is sent whole by --tags', () => {
  const cliTestClient = createCliTestClient();

  beforeEach(() => {
    cliTestClient.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const pathFlagsFor = (command: string): string[] => {
    return routes[command as keyof typeof routes].pathParams.flatMap(
      (param) => {
        return [`--${param.replace(/_/g, '-')}`, `${param}_1`];
      }
    );
  };

  test('every replace and merge tag command carries its bag in --tags', () => {
    expect(tagBagCommands).toHaveLength(14);
    for (const command of tagBagCommands) {
      expect(command).toMatch(/^(replace|merge)-[a-z-]+-tags$/);
      const flag = routes[command as keyof typeof routes].flags.find((f) => {
        return f.in === 'body-root';
      });
      expect(flag).toMatchObject({
        name: 'tags',
        type: 'object',
        required: true,
      });
    }
  });

  test.each(tagBagCommands)(
    '%s sends the bag as the request body',
    async (command) => {
      const requests = await cliTestClient.call([
        command,
        ...pathFlagsFor(command),
        '--tags',
        '{"team":"finance","cost_center":"cc-42"}',
      ]);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toEqual({
        team: 'finance',
        cost_center: 'cc-42',
      });
    }
  );

  test('an empty bag is sent, so replace can clear every tag', async () => {
    const requests = await cliTestClient.call([
      'replace-actor-tags',
      '--actor-id',
      'actor_1',
      '--tags',
      '{}',
    ]);

    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.path).toBe('/api/v1/actors/actor_1/tags');
    expect(requests[0]?.body).toEqual({});
  });

  test('--help lists --tags as a required object flag', async () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code}`);
    }) as typeof process.exit);

    await expect(
      cliTestClient.call(['replace-actor-tags', '--help'])
    ).rejects.toThrow('EXIT_0');

    expect(lines.join('\n')).toMatch(/--tags {2}<object> \[required\]/);
  });
});
