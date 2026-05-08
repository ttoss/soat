import { canAccessFile } from 'src/lib/fileAuthorization';

describe('fileAuthorization', () => {
  test('builds resources/context without tags', async () => {
    const isAllowed = jest.fn().mockResolvedValue(true);

    const allowed = await canAccessFile({
      authUser: {
        isAllowed,
      } as never,
      action: 'files:GetFile',
      file: {
        id: 'fil_1',
        projectId: 'prj_1',
        path: null,
        tags: null,
      },
    });

    expect(allowed).toBe(true);
    expect(isAllowed).toHaveBeenCalledWith({
      projectPublicId: 'prj_1',
      action: 'files:GetFile',
      resources: ['soat:prj_1:file:fil_1'],
      context: {
        'soat:ResourceType': 'file',
      },
    });
  });

  test('builds resources/context with tags and path', async () => {
    const isAllowed = jest.fn().mockResolvedValue(false);

    const allowed = await canAccessFile({
      authUser: {
        isAllowed,
      } as never,
      action: 'files:DownloadFile',
      file: {
        id: 'fil_2',
        projectId: 'prj_2',
        path: 'folder/report.csv',
        tags: { env: 'prod', team: 'data' },
      },
    });

    expect(allowed).toBe(false);
    expect(isAllowed).toHaveBeenCalledWith({
      projectPublicId: 'prj_2',
      action: 'files:DownloadFile',
      resources: ['soat:prj_2:file:fil_2', 'soat:prj_2:file:folder/report.csv'],
      context: {
        'soat:ResourceType': 'file',
        'soat:ResourceTag/env': 'prod',
        'soat:ResourceTag/team': 'data',
      },
    });
  });
});
