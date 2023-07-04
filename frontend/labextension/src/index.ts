import { IChangedArgs } from '@jupyterlab/coreutils/lib/interfaces';

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from '@jupyterlab/application';

import { ICommandPalette, ISessionContext } from '@jupyterlab/apputils';

import { Cell, CodeCell, ICellModel, ICodeCellModel } from '@jupyterlab/cells';

import { INotebookTracker, Notebook } from '@jupyterlab/notebook';

import _ from 'lodash';

type Highlights = 'all' | 'none' | 'executed' | 'reactive';

const waitingClass = 'waiting-cell';
const readyClass = 'ready-cell';
const readyMakingClass = 'ready-making-cell';
const readyMakingInputClass = 'ready-making-input-cell';
const linkedWaitingClass = 'linked-waiting';
const linkedReadyMakerClass = 'linked-ready-maker';
const selfSliceClass = 'ipyflow-slice-self';
const directSliceClass = 'ipyflow-slice-direct';
const sliceClass = 'ipyflow-slice';

const cleanup = new Event('cleanup');

// ipyflow frontend state
type IpyflowSessionState = {
  isIpyflowCommConnected: boolean;
  dirtyCells: Set<string>;
  waitingCells: Set<string>;
  readyCells: Set<string>;
  waiterLinks: { [id: string]: string[] };
  readyMakerLinks: { [id: string]: string[] };
  prevActiveCell: Cell<ICellModel> | null;
  activeCell: Cell<ICellModel>;
  cellsById: { [id: string]: Cell<ICellModel> };
  orderIdxById: { [id: string]: number };
  cellPendingExecution: CodeCell;
  lastExecutionMode: string;
  isReactivelyExecuting: boolean;
  numAltModeExecutes: number;
  lastExecutionHighlights: Highlights;
  executedReactiveReadyCells: Set<string>;
  newReadyCells: Set<string>;
  forcedReactiveCells: Set<string>;
  cellParents: { [id: string]: string[] };
  cellChildren: { [id: string]: string[] };
  settings: { [key: string]: string };
};

type IpyflowState = {
  [session_id: string]: IpyflowSessionState;
};

const ipyflowState: IpyflowState = {};

function initSessionState(session_id: string): void {
  ipyflowState[session_id] = {
    isIpyflowCommConnected: false,
    dirtyCells: new Set(),
    waitingCells: new Set(),
    readyCells: new Set(),
    waiterLinks: {},
    readyMakerLinks: {},
    prevActiveCell: null,
    activeCell: null,
    cellsById: {},
    orderIdxById: {},
    cellPendingExecution: null,
    lastExecutionMode: null,
    isReactivelyExecuting: false,
    numAltModeExecutes: 0,
    lastExecutionHighlights: null,
    executedReactiveReadyCells: new Set(),
    newReadyCells: new Set(),
    forcedReactiveCells: new Set(),
    cellParents: {},
    cellChildren: {},
    settings: {},
  };
}

function resetSessionState(session_id: string): void {
  delete ipyflowState[session_id];
}

function computeTransitiveClosureHelper(
  closure: Set<string>,
  cellId: string,
  edges: { [id: string]: string[] }
): void {
  if (closure.has(cellId)) {
    return;
  }
  closure.add(cellId);
  const children = edges[cellId];
  if (children === undefined) {
    return;
  }
  children.forEach((child) =>
    computeTransitiveClosureHelper(closure, child, edges)
  );
}

function computeTransitiveClosure(
  cellIds: string[],
  state: IpyflowSessionState,
  inclusive = true
): Cell<ICellModel>[] {
  const closure = new Set<string>();
  for (const cellId of cellIds) {
    computeTransitiveClosureHelper(closure, cellId, state.cellChildren);
    if (!inclusive) {
      closure.delete(cellId);
    }
  }
  return Array.from(closure)
    .sort((a, b) => state.orderIdxById[a] - state.orderIdxById[b])
    .map((id) => state.cellsById[id]);
}

function executeCells(
  cells: Array<Cell<ICellModel>>,
  session: ISessionContext
) {
  for (const cell of cells) {
    // if any of them fail, change the [*] to [ ] on subsequent cells
    CodeCell.execute(cell as CodeCell, session).then((msg) => {
      if ((msg as any)?.content?.status === 'error') {
        for (const cell of cells) {
          if (cell.promptNode.textContent?.includes('[*]')) {
            cell.setPrompt('');
          }
        }
      }
    });
  }
}

/**
 * Initialization data for the jupyterlab-ipyflow extension.
 */
const extension: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-ipyflow',
  requires: [INotebookTracker, ICommandPalette],
  autoStart: true,
  activate: (
    app: JupyterFrontEnd,
    notebooks: INotebookTracker,
    palette: ICommandPalette
  ) => {
    app.commands.addCommand('alt-mode-execute', {
      label: 'Alt Mode Execute',
      isEnabled: () => true,
      isVisible: () => true,
      isToggled: () => false,
      execute: () => {
        const session = notebooks.currentWidget.sessionContext;
        if (!session.isReady) {
          return;
        }
        app.commands.execute('notebook:enter-command-mode');
        const state: IpyflowSessionState = (ipyflowState[session.session.id] ??
          {}) as IpyflowSessionState;
        if (!(state.isIpyflowCommConnected ?? false)) {
          CodeCell.execute(notebooks.activeCell as CodeCell, session);
          return;
        }
        if (notebooks.activeCell.model.type !== 'code') {
          return;
        }
        state.numAltModeExecutes++;
        if (
          state.settings.reactivity_mode === 'incremental' ||
          state.settings.exec_mode === 'reactive'
        ) {
          if (state.numAltModeExecutes === 1) {
            session.session.kernel
              .requestExecute({
                code: '%flow toggle-reactivity',
                silent: true,
                store_history: false,
              })
              .done.then(() => {
                CodeCell.execute(notebooks.activeCell as CodeCell, session);
              });
          } else {
            CodeCell.execute(notebooks.activeCell as CodeCell, session);
          }
        } else if (state.settings.reactivity_mode === 'batch') {
          const closure = computeTransitiveClosure(
            [notebooks.activeCell.model.id],
            state
          );
          executeCells(closure, session);
        } else {
          console.error(
            `Unknown reactivity mode: ${state.settings.reactivity_mode}`
          );
        }
      },
    });
    app.commands.addKeyBinding({
      command: 'alt-mode-execute',
      keys: ['Accel Shift Enter'],
      selector: '.jp-Notebook',
    });
    app.commands.addKeyBinding({
      command: 'alt-mode-execute',
      keys: ['Ctrl Shift Enter'],
      selector: '.jp-Notebook',
    });
    palette.addItem({
      command: 'alt-mode-execute',
      category: 'execution',
      args: {},
    });

    app.commands.addCommand('execute-remaining', {
      label: 'Execute Remaining Cells',
      isEnabled: () => true,
      isVisible: () => true,
      isToggled: () => false,
      execute: () => {
        const session = notebooks.currentWidget.sessionContext;
        if (!session.isReady) {
          return;
        }
        const state: IpyflowSessionState = (ipyflowState[session.session.id] ??
          {}) as IpyflowSessionState;
        if (state.isIpyflowCommConnected ?? false) {
          const closure = computeTransitiveClosure(
            [state.activeCell.model.id],
            state,
            false
          );
          executeCells(closure, session);
        }
      },
    });
    app.commands.commandExecuted.connect((_, args) => {
      const session = notebooks.currentWidget.sessionContext;
      if (!session.isReady) {
        return;
      }
      const state: IpyflowSessionState = (ipyflowState[session.session.id] ??
        {}) as IpyflowSessionState;
      if (!(state.isIpyflowCommConnected ?? false)) {
        return;
      }
      if (
        state.settings?.exec_mode !== 'reactive' ||
        state.settings?.reactivity_mode !== 'batch'
      ) {
        return;
      }
      if (args.id === 'notebook:run-cell') {
        app.commands.execute('execute-remaining');
      } else if (args.id === 'notebook:run-cell-and-select-next') {
        const origActiveCell = state.activeCell;
        try {
          state.activeCell = state.prevActiveCell;
          app.commands.execute('execute-remaining');
        } finally {
          state.activeCell = origActiveCell;
        }
      }
    });
    notebooks.widgetAdded.connect((sender, nbPanel) => {
      const session = nbPanel.sessionContext;
      let commDisconnectHandler = () => resetSessionState(session.session.id);

      const registerCommTarget = () => {
        session.session.kernel.registerCommTarget(
          'ipyflow-client',
          (comm, _open_msg) => {
            comm.onMsg = (msg) => {
              const payload = msg.content.data;
              if (!(payload.success ?? true)) {
                return;
              }
              if (payload.type === 'unestablish') {
                commDisconnectHandler();
              } else if (payload.type === 'establish') {
                commDisconnectHandler();
                commDisconnectHandler = connectToComm(session, nbPanel.content);
              }
            };
            commDisconnectHandler();
            commDisconnectHandler = connectToComm(session, nbPanel.content);
          }
        );
      };

      session.ready.then(() => {
        clearCellState(nbPanel.content);
        registerCommTarget();
        commDisconnectHandler();
        commDisconnectHandler = connectToComm(session, nbPanel.content);
        session.kernelChanged.connect((_, args) => {
          if (args.newValue == null) {
            return;
          }
          clearCellState(nbPanel.content);
          commDisconnectHandler();
          resetSessionState(session.session.id);
          commDisconnectHandler = () => resetSessionState(session.session.id);
          session.ready.then(() => {
            registerCommTarget();
            commDisconnectHandler = connectToComm(session, nbPanel.content);
          });
        });
      });
    });
  },
};

const getJpInputCollapser = (elem: HTMLElement) => {
  if (elem === null || elem === undefined) {
    return null;
  }
  const child = elem.children.item(1);
  if (child === null) {
    return null;
  }
  return child.firstElementChild;
};

const getJpOutputCollapser = (elem: HTMLElement) => {
  if (elem === null || elem === undefined) {
    return null;
  }
  const child = elem.children.item(2);
  if (child === null) {
    return null;
  }
  return child.firstElementChild;
};

const attachCleanupListener = (
  elem: Element,
  evt: 'mouseover' | 'mouseout',
  listener: any
) => {
  const cleanupListener = () => {
    elem.removeEventListener(evt, listener);
    elem.removeEventListener('cleanup', cleanupListener);
  };
  elem.addEventListener(evt, listener);
  elem.addEventListener('cleanup', cleanupListener);
};

const addWaitingOutputInteraction = (
  elem: Element,
  linkedElem: Element,
  evt: 'mouseover' | 'mouseout',
  add_or_remove: 'add' | 'remove',
  css: string
) => {
  if (elem === null || linkedElem === null) {
    return;
  }
  const listener = () => {
    linkedElem.firstElementChild.classList[add_or_remove](css);
  };
  attachCleanupListener(elem, evt, listener);
};

const addWaitingOutputInteractions = (
  elem: HTMLElement,
  linkedInputClass: string
) => {
  addWaitingOutputInteraction(
    getJpInputCollapser(elem),
    getJpOutputCollapser(elem),
    'mouseover',
    'add',
    linkedWaitingClass
  );
  addWaitingOutputInteraction(
    getJpInputCollapser(elem),
    getJpOutputCollapser(elem),
    'mouseout',
    'remove',
    linkedWaitingClass
  );

  addWaitingOutputInteraction(
    getJpOutputCollapser(elem),
    getJpInputCollapser(elem),
    'mouseover',
    'add',
    linkedInputClass
  );
  addWaitingOutputInteraction(
    getJpOutputCollapser(elem),
    getJpInputCollapser(elem),
    'mouseout',
    'remove',
    linkedInputClass
  );
};

const clearCellState = (notebook: Notebook) => {
  notebook.widgets.forEach((cell) => {
    cell.node.classList.remove(waitingClass);
    cell.node.classList.remove(readyMakingClass);
    cell.node.classList.remove(readyClass);
    cell.node.classList.remove(readyMakingInputClass);

    // clear any old event listeners
    const inputCollapser = getJpInputCollapser(cell.node);
    if (inputCollapser !== null) {
      inputCollapser.firstElementChild.classList.remove(linkedWaitingClass);
      inputCollapser.firstElementChild.classList.remove(linkedReadyMakerClass);
      inputCollapser.dispatchEvent(cleanup);
    }

    const outputCollapser = getJpOutputCollapser(cell.node);
    if (outputCollapser !== null) {
      outputCollapser.firstElementChild.classList.remove(linkedWaitingClass);
      outputCollapser.firstElementChild.classList.remove(linkedReadyMakerClass);
      outputCollapser.dispatchEvent(cleanup);
    }
  });
};

const addUnsafeCellInteraction = (
  elem: Element,
  linkedElems: string[],
  cellsById: { [id: string]: Cell },
  collapserFun: (elem: HTMLElement) => Element,
  evt: 'mouseover' | 'mouseout',
  add_or_remove: 'add' | 'remove',
  waitingCells: Set<string>
) => {
  if (elem === null) {
    return;
  }
  const listener = () => {
    for (const linkedId of linkedElems) {
      let css = linkedReadyMakerClass;
      if (waitingCells.has(linkedId)) {
        css = linkedWaitingClass;
      }
      const collapser = collapserFun(cellsById[linkedId].node);
      if (collapser === null || collapser.firstElementChild === null) {
        return;
      }
      collapser.firstElementChild.classList[add_or_remove](css);
    }
  };
  elem.addEventListener(evt, listener);
  attachCleanupListener(elem, evt, listener);
};

const connectToComm = (session: ISessionContext, notebook: Notebook) => {
  initSessionState(session.session.id);
  const state = ipyflowState[session.session.id];
  state.activeCell = notebook.activeCell;
  const comm = session.session.kernel.createComm('ipyflow', 'ipyflow');
  let disconnected = false;

  const gatherCellMetadataAndContent = () => {
    const cell_metadata_by_id: {
      [id: string]: {
        index: number;
        content: string;
        type: string;
      };
    } = {};
    notebook.widgets.forEach((itercell, idx) => {
      const model = itercell.model;
      cell_metadata_by_id[model.id] = {
        index: idx,
        content: model.sharedModel.getSource(),
        type: model.type,
      };
    });
    return cell_metadata_by_id;
  };

  const syncDirtiness = (cell: Cell<ICellModel>) => {
    if (cell !== null && cell.model !== null) {
      if ((<ICodeCellModel>cell.model).isDirty) {
        state.dirtyCells.add(cell.model.id);
      } else {
        state.dirtyCells.delete(cell.model.id);
      }
    }
  };

  const onContentChanged = _.debounce(() => {
    if (disconnected) {
      notebook.model.contentChanged.disconnect(onContentChanged);
      return;
    }
    notebook.widgets.forEach(syncDirtiness);
    comm.send({
      type: 'notify_content_changed',
      cell_metadata_by_id: gatherCellMetadataAndContent(),
    });
  }, 500);

  const requestComputeExecSchedule = (cell?: ICellModel) => {
    const cell_metadata_by_id = gatherCellMetadataAndContent();
    comm.send({
      type: 'compute_exec_schedule',
      executed_cell_id: cell?.id,
      cell_metadata_by_id,
      is_reactively_executing: state.isReactivelyExecuting,
    });
  };

  const onExecution = (cell: ICellModel, args: IChangedArgs<any>) => {
    if (disconnected) {
      cell.stateChanged.disconnect(onExecution);
      return;
    }
    if (args.name !== 'executionCount' || args.newValue === null) {
      return;
    }
    state.dirtyCells.delete(cell.id);
    notebook.widgets.forEach((itercell) => {
      if (itercell.model.id === cell.id) {
        itercell.node.classList.remove(readyClass);
        itercell.node.classList.remove(readyMakingInputClass);
      }
    });
    requestComputeExecSchedule(cell);
  };

  const notifyActiveCell = (newActiveCell: ICellModel) => {
    let newActiveCellOrderIdx = -1;
    notebook.widgets.forEach((itercell, idx) => {
      if (itercell.model.id === newActiveCell.id) {
        newActiveCellOrderIdx = idx;
      }
    });
    const payload = {
      type: 'change_active_cell',
      active_cell_id: newActiveCell.id,
      active_cell_order_idx: newActiveCellOrderIdx,
    };
    comm.send(payload);
  };

  const refreshNodeMapping = (notebook: Notebook) => {
    state.cellsById = {};
    state.orderIdxById = {};

    notebook.widgets.forEach((cell, idx) => {
      state.cellsById[cell.model.id] = cell;
      state.orderIdxById[cell.model.id] = idx;
    });
  };

  const onActiveCellChange = (nb: Notebook, cell: Cell<ICellModel>) => {
    if (notebook !== nb) {
      return;
    }
    if (disconnected) {
      notebook.activeCellChanged.disconnect(onActiveCellChange);
      return;
    }
    notifyActiveCell(cell.model);
    state.activeCell.model.stateChanged.disconnect(
      onExecution,
      state.activeCell.model.stateChanged
    );
    state.prevActiveCell = state.activeCell;
    state.activeCell = cell;

    if (
      state.activeCell === null ||
      state.activeCell.model === null ||
      state.activeCell.model.type !== 'code'
    ) {
      return;
    }

    state.activeCell.model.stateChanged.connect(onExecution);
    notifyActiveCell(state.activeCell.model);

    if (state.dirtyCells.has(state.activeCell.model.id)) {
      (state.activeCell.model as any)._setDirty?.(true);
    }
    refreshNodeMapping(notebook);
    if (state.settings.reactivity_mode === 'batch') {
      updateUI(notebook);
    } else {
      updateOneCellUI(
        state.activeCell.model.id,
        false,
        false,
        false,
        state.lastExecutionHighlights !== 'none'
      );
    }
  };

  const actionUpdatePairs: {
    action: 'mouseover' | 'mouseout';
    update: 'add' | 'remove';
  }[] = [
    {
      action: 'mouseover',
      update: 'add',
    },
    {
      action: 'mouseout',
      update: 'remove',
    },
  ];

  const updateOneCellUI = (
    id: string,
    isSelf: boolean,
    inDirectSlice: boolean,
    inSlice: boolean,
    showCollapserHighlights: boolean
  ) => {
    const model = state.cellsById[id].model;
    if (model.type !== 'code') {
      return;
    }
    const codeModel = model as ICodeCellModel;
    if (codeModel.executionCount == null) {
      return;
    }
    const elem = state.cellsById[id].node;
    if (isSelf) {
      elem.classList.add(selfSliceClass);
    } else {
      elem.classList.remove(selfSliceClass);
    }
    if (inDirectSlice && !isSelf) {
      elem.classList.add(directSliceClass);
    } else {
      elem.classList.remove(directSliceClass);
    }
    if (inSlice && !inDirectSlice && !isSelf) {
      elem.classList.add(sliceClass);
    } else {
      elem.classList.remove(sliceClass);
    }
    if (!showCollapserHighlights) {
      return;
    }
    if (state.waitingCells.has(id)) {
      elem.classList.add(waitingClass);
      elem.classList.add(readyClass);
      elem.classList.remove(readyMakingInputClass);
      addWaitingOutputInteractions(elem, linkedWaitingClass);
    } else if (state.readyCells.has(id)) {
      elem.classList.add(readyMakingInputClass);
      elem.classList.add(readyClass);
      addWaitingOutputInteractions(elem, linkedReadyMakerClass);
    }

    if (state.lastExecutionMode === 'reactive') {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(state.waiterLinks, id)) {
      actionUpdatePairs.forEach(({ action, update }) => {
        addUnsafeCellInteraction(
          getJpInputCollapser(elem),
          state.waiterLinks[id],
          state.cellsById,
          getJpInputCollapser,
          action,
          update,
          state.waitingCells
        );

        addUnsafeCellInteraction(
          getJpOutputCollapser(elem),
          state.waiterLinks[id],
          state.cellsById,
          getJpInputCollapser,
          action,
          update,
          state.waitingCells
        );
      });
    }

    if (Object.prototype.hasOwnProperty.call(state.readyMakerLinks, id)) {
      if (!state.waitingCells.has(id)) {
        elem.classList.add(readyMakingClass);
        elem.classList.add(readyClass);
      }
      actionUpdatePairs.forEach(({ action, update }) => {
        addUnsafeCellInteraction(
          getJpInputCollapser(elem),
          state.readyMakerLinks[id],
          state.cellsById,
          getJpInputCollapser,
          action,
          update,
          state.waitingCells
        );

        addUnsafeCellInteraction(
          getJpInputCollapser(elem),
          state.readyMakerLinks[id],
          state.cellsById,
          getJpOutputCollapser,
          action,
          update,
          state.waitingCells
        );
      });
    }
  };

  const updateUI = (notebook: Notebook) => {
    clearCellState(notebook);
    refreshNodeMapping(notebook);
    const slice = new Set<string>();
    let directSlice = new Set<string>();
    const activeCellId = state.activeCell.model.id;
    if (
      state.settings.reactivity_mode === 'batch' &&
      (Object.prototype.hasOwnProperty.call(state.cellChildren, activeCellId) ||
        Object.prototype.hasOwnProperty.call(state.cellParents, activeCellId))
    ) {
      directSlice = new Set([
        activeCellId,
        ...state.cellChildren[activeCellId],
        ...state.cellParents[activeCellId],
      ]);
      computeTransitiveClosureHelper(slice, activeCellId, state.cellChildren);
      slice.delete(activeCellId);
      computeTransitiveClosureHelper(slice, activeCellId, state.cellParents);
    }
    for (const [id] of Object.entries(state.cellsById)) {
      updateOneCellUI(
        id,
        id === activeCellId && directSlice.has(id),
        directSlice.has(id),
        slice.has(id),
        state.lastExecutionHighlights !== 'none'
      );
    }
  };

  comm.onMsg = (msg) => {
    const payload = msg.content.data;
    if (disconnected || !(payload.success ?? true)) {
      return;
    }
    if (payload.type === 'establish') {
      state.isIpyflowCommConnected = true;
      notebook.activeCellChanged.connect(onActiveCellChange);
      notebook.activeCell.model.stateChanged.connect(onExecution);
      notifyActiveCell(notebook.activeCell.model);
      notebook.model.contentChanged.connect(onContentChanged);
      requestComputeExecSchedule();
    } else if (payload.type === 'set_exec_mode') {
      state.numAltModeExecutes = 0;
      state.lastExecutionMode = payload.exec_mode as string;
    } else if (payload.type === 'compute_exec_schedule') {
      state.settings = payload.settings as { [key: string]: string };
      state.cellParents = payload.cell_parents as { [id: string]: string[] };
      state.cellChildren = payload.cell_children as { [id: string]: string[] };
      state.waitingCells = new Set(payload.waiting_cells as string[]);
      state.readyCells = new Set(payload.ready_cells as string[]);
      state.newReadyCells = new Set([
        ...state.newReadyCells,
        ...(payload.new_ready_cells as string[]),
      ]);
      state.forcedReactiveCells = new Set([
        ...state.forcedReactiveCells,
        ...(payload.forced_reactive_cells as string[]),
      ]);
      state.waiterLinks = payload.waiter_links as { [id: string]: string[] };
      state.readyMakerLinks = payload.ready_maker_links as {
        [id: string]: string[];
      };
      state.cellPendingExecution = null;
      const exec_mode = payload.exec_mode as string;
      state.isReactivelyExecuting =
        state.isReactivelyExecuting ||
        ((payload?.is_reactively_executing as boolean) ?? false);
      const flow_order = payload.flow_order;
      const exec_schedule = payload.exec_schedule;
      state.lastExecutionMode = exec_mode;
      state.lastExecutionHighlights = payload.highlights as Highlights;
      const lastExecutedCellId = payload.last_executed_cell_id as string;
      state.executedReactiveReadyCells.add(lastExecutedCellId);
      const last_execution_was_error =
        payload.last_execution_was_error as boolean;
      if (!last_execution_was_error) {
        if (state.settings.reactivity_mode === 'batch') {
          let batchedReactiveCells = Array.from(state.forcedReactiveCells);
          if (state.isReactivelyExecuting || exec_mode === 'reactive') {
            batchedReactiveCells = [
              ...batchedReactiveCells,
              ...Array.from(state.newReadyCells),
            ];
          }
          batchedReactiveCells = batchedReactiveCells.filter(
            (id) => !state.executedReactiveReadyCells.has(id)
          );
          const closure = computeTransitiveClosure(batchedReactiveCells, state);
          executeCells(closure, session);
        } else {
          let lastExecutedCellIdSeen = false;
          for (const cell of notebook.widgets) {
            if (!lastExecutedCellIdSeen) {
              lastExecutedCellIdSeen = cell.model.id === lastExecutedCellId;
              if (flow_order === 'in_order' || exec_schedule === 'strict') {
                continue;
              }
            }
            if (
              cell.model.type !== 'code' ||
              state.executedReactiveReadyCells.has(cell.model.id)
            ) {
              continue;
            }
            if (!state.newReadyCells.has(cell.model.id)) {
              continue;
            }
            if (
              !state.forcedReactiveCells.has(cell.model.id) &&
              !(state.isReactivelyExecuting || exec_mode === 'reactive')
            ) {
              continue;
            }
            const codeCell = cell as CodeCell;
            if (state.cellPendingExecution === null) {
              state.cellPendingExecution = codeCell;
              // break early if using one of the order-based semantics
              if (flow_order === 'in_order' || exec_schedule === 'strict') {
                break;
              }
            } else if (codeCell.model.executionCount == null) {
              // pass
            } else if (
              codeCell.model.executionCount <
              state.cellPendingExecution.model.executionCount
            ) {
              // otherwise, execute in order of earliest execution counter
              state.cellPendingExecution = codeCell;
            }
          }
        }
      }
      if (state.cellPendingExecution === null) {
        if (state.isReactivelyExecuting) {
          if (state.lastExecutionHighlights === 'reactive') {
            state.readyCells = state.executedReactiveReadyCells;
          }
          comm.send({
            type: 'reactivity_cleanup',
          });
        }
        state.forcedReactiveCells = new Set();
        state.newReadyCells = new Set();
        state.executedReactiveReadyCells = new Set();
        updateUI(notebook);
        state.isReactivelyExecuting = false;
        if (
          state.numAltModeExecutes > 0 &&
          --state.numAltModeExecutes === 0 &&
          (state.settings.reactivty_mode === 'incremental' ||
            state.settings.exec_mode === 'reactive')
        ) {
          session.session.kernel.requestExecute({
            code: '%flow toggle-reactivity',
            silent: true,
            store_history: false,
          });
        }
      } else {
        state.isReactivelyExecuting = true;
        onActiveCellChange(notebook, state.cellPendingExecution);
        CodeCell.execute(state.cellPendingExecution, session);
      }
    }
  };
  comm.open({
    interface: 'jupyterlab',
  });
  // return a disconnection handle
  return () => {
    comm.dispose();
    disconnected = true;
    state.isIpyflowCommConnected = false;
    resetSessionState(session.session.id);
  };
};

export default extension;
