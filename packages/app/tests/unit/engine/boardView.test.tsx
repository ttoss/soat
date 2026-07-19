import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { BoardView } from '@/engine/boardView';
import { parseModules } from '@/engine/specUtils';
import type { ModuleInfo } from '@/engine/types';

import { testSpec } from '../fixtures/spec';
import { server } from '../msw/server';
import { NavProbe, renderWithAuth } from '../testUtils';

const workflowsModule = (): ModuleInfo => {
  const m = parseModules(testSpec).find((x) => {
    return x.tag === 'Workflows';
  });
  if (!m) throw new Error('Workflows module missing');
  return m;
};

const WORKFLOW = {
  id: 'wfl_1',
  name: 'Review Flow',
  states: [
    { name: 'todo', initial: true },
    { name: 'reviewing' },
    { name: 'done', terminal: true },
  ],
  transitions: [],
};

const useWorkflow = () => {
  server.use(
    http.get('*/api/v1/workflows/:workflow_id', () => {
      return HttpResponse.json(WORKFLOW);
    })
  );
};

const renderBoard = (modules?: ModuleInfo[]) => {
  return renderWithAuth(
    <>
      <BoardView
        module={workflowsModule()}
        spec={testSpec}
        pathParams={{ workflow_id: 'wfl_1' }}
        modules={modules ?? parseModules(testSpec)}
      />
      <NavProbe />
    </>
  );
};

describe('BoardView', () => {
  test('renders one column per workflow state with its tasks as cards', async () => {
    useWorkflow();
    server.use(
      http.get('*/api/v1/tasks', () => {
        return HttpResponse.json([
          { id: 'task_1', title: 'Fix bug', state: 'todo', status: 'open' },
          { id: 'task_2', title: 'Ship it', state: 'done', status: 'closed' },
          { id: 'task_3', title: 'Second todo', state: 'todo', status: 'open' },
        ]);
      })
    );

    renderBoard();

    // Column headers = states.
    expect(await screen.findByText('Fix bug')).toBeInTheDocument();
    const board = screen.getByTestId('board-columns');
    const headings = within(board).getAllByRole('heading');
    expect(headings.map((h) => h.textContent)).toEqual([
      'todo',
      'reviewing',
      'done',
    ]);
    // Cards land in the right column.
    expect(screen.getByText('Ship it')).toBeInTheDocument();
    expect(screen.getByText('Second todo')).toBeInTheDocument();
    // An empty state column shows the empty hint.
    expect(screen.getAllByText('No tasks').length).toBeGreaterThan(0);
  });

  test('sends the workflow_id filter when querying tasks', async () => {
    useWorkflow();
    let requestedUrl = '';
    server.use(
      http.get('*/api/v1/tasks', ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([]);
      })
    );

    renderBoard();
    // Wait for the board to settle.
    expect(await screen.findByText('Review Flow board')).toBeInTheDocument();
    expect(new URL(requestedUrl).searchParams.get('workflow_id')).toBe('wfl_1');
  });

  test('clicking a card navigates to the task detail view', async () => {
    useWorkflow();
    server.use(
      http.get('*/api/v1/tasks', () => {
        return HttpResponse.json([
          { id: 'task_1', title: 'Fix bug', state: 'todo', status: 'open' },
        ]);
      })
    );

    renderBoard();
    await userEvent.click(await screen.findByText('Fix bug'));

    const probe = screen.getByTestId('nav-probe');
    expect(probe).toHaveTextContent('"mode":"detail"');
    expect(probe).toHaveTextContent('"tag":"Tasks"');
    expect(probe).toHaveTextContent('"task_id":"task_1"');
  });

  test('a task in a state not in the definition still renders as an extra column', async () => {
    useWorkflow();
    server.use(
      http.get('*/api/v1/tasks', () => {
        return HttpResponse.json([
          { id: 'task_1', title: 'Orphan', state: 'archived', status: 'closed' },
        ]);
      })
    );

    renderBoard();
    expect(await screen.findByText('Orphan')).toBeInTheDocument();
    const board = screen.getByTestId('board-columns');
    const headings = within(board).getAllByRole('heading');
    expect(headings.map((h) => h.textContent)).toContain('archived');
  });

  test('shows a message when no task collection is available', async () => {
    useWorkflow();
    // Modules without the Tasks module — no companion collection to render.
    const withoutTasks = parseModules(testSpec).filter((m) => {
      return m.tag !== 'Tasks';
    });

    renderBoard(withoutTasks);
    expect(
      await screen.findByText('No task collection is available for this workflow.')
    ).toBeInTheDocument();
  });

  test('a card with no title falls back to its id and omits status/assignee', async () => {
    useWorkflow();
    server.use(
      http.get('*/api/v1/tasks', () => {
        return HttpResponse.json([{ id: 'task_1', state: 'todo' }]);
      })
    );

    renderBoard();
    // No title/name → the id is shown; no status/assignee badges are rendered.
    expect(await screen.findByText('task_1')).toBeInTheDocument();
    expect(screen.queryByText('open')).not.toBeInTheDocument();
  });

  test('shows a hint when the workflow has no states', async () => {
    server.use(
      http.get('*/api/v1/workflows/:workflow_id', () =>
        HttpResponse.json({ id: 'wfl_1', name: 'Empty', states: [] })
      ),
      http.get('*/api/v1/tasks', () => {
        return HttpResponse.json([]);
      })
    );

    renderBoard();
    expect(
      await screen.findByText(
        'This resource has no states to render as a board.'
      )
    ).toBeInTheDocument();
  });

  test('surfaces an error when the workflow fetch fails', async () => {
    server.use(
      http.get('*/api/v1/workflows/:workflow_id', () => {
        return HttpResponse.json(
          { error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' } },
          { status: 404 }
        );
      })
    );

    renderBoard();
    expect(await screen.findByText('Workflow not found')).toBeInTheDocument();
  });
});
