import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { ProjectsScreen } from '@/views/projectsScreen';
import { parseModules } from '@/engine/specUtils';
import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { NavProbe, renderWithAuth } from '../testUtils';

const projectsModule = parseModules(testSpec).find((m) => m.tag === 'Projects')!;

const TWO_PROJECTS = [
  { id: 'prj_1', name: 'Alpha Project', description: 'First project' },
  { id: 'prj_2', name: 'Beta Project' },
];

const renderProjectsScreen = (initialPath = '/app/v1/projects') => {
  return renderWithAuth(
    <>
      <ProjectsScreen
        module={projectsModule}
        spec={testSpec}
        pathParams={{}}
      />
      <NavProbe />
    </>,
    { initialPath }
  );
};

test('shows loading state initially', () => {
  server.use(
    http.get('*/api/v1/projects', async () => {
      await new Promise(() => {});
      return HttpResponse.json([]);
    })
  );
  renderProjectsScreen();
  expect(screen.getByText('Loading projects…')).toBeInTheDocument();
});

test('renders a card per project with name', async () => {
  server.use(
    http.get('*/api/v1/projects', () => HttpResponse.json(TWO_PROJECTS))
  );
  renderProjectsScreen();

  expect(await screen.findByText('Alpha Project')).toBeInTheDocument();
  expect(screen.getByText('Beta Project')).toBeInTheDocument();
});

test('shows description when present', async () => {
  server.use(
    http.get('*/api/v1/projects', () => HttpResponse.json(TWO_PROJECTS))
  );
  renderProjectsScreen();

  expect(await screen.findByText('First project')).toBeInTheDocument();
});

test('shows Active badge on the selected project', async () => {
  server.use(
    http.get('*/api/v1/projects', () => HttpResponse.json(TWO_PROJECTS))
  );
  renderProjectsScreen('/app/v1/projects/prj_1');

  expect(await screen.findByText('Active')).toBeInTheDocument();
});

test('"Select" button is disabled on the active project', async () => {
  server.use(
    http.get('*/api/v1/projects', () => HttpResponse.json(TWO_PROJECTS))
  );
  renderProjectsScreen('/app/v1/projects/prj_1');

  await screen.findByText('Alpha Project');
  const selectedButtons = screen.getAllByRole('button', { name: 'Selected' });
  expect(selectedButtons[0]).toBeDisabled();
});

test('"View →" button navigates to project detail', async () => {
  server.use(
    http.get('*/api/v1/projects', () => HttpResponse.json(TWO_PROJECTS))
  );
  renderProjectsScreen();

  await screen.findByText('Alpha Project');
  const viewButtons = screen.getAllByRole('button', { name: 'View →' });
  await userEvent.click(viewButtons[0]);

  const probe = screen.getByTestId('nav-probe');
  expect(probe).toHaveTextContent('"mode":"detail"');
  expect(probe).toHaveTextContent('"tag":"Projects"');
});

test('"New Project" button navigates to create mode', async () => {
  server.use(
    http.get('*/api/v1/projects', () => HttpResponse.json(TWO_PROJECTS))
  );
  renderProjectsScreen();

  await screen.findByText('Alpha Project');
  await userEvent.click(screen.getByRole('button', { name: /new project/i }));

  const probe = screen.getByTestId('nav-probe');
  expect(probe).toHaveTextContent('"mode":"create"');
  expect(probe).toHaveTextContent('"tag":"Projects"');
});

test('shows empty state when no projects exist', async () => {
  renderProjectsScreen();
  expect(await screen.findByText('No projects yet.')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /create your first project/i })
  ).toBeInTheDocument();
});

test('shows error message on fetch failure', async () => {
  server.use(
    http.get('*/api/v1/projects', () =>
      HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  );
  renderProjectsScreen();
  expect(await screen.findByText(/unauthorized/i)).toBeInTheDocument();
});
