import {
  IChangedArgs
} from '@jupyterlab/coreutils/lib/interfaces';

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import {
  ISessionContext
} from '@jupyterlab/apputils';

import {
  Cell,
  CodeCell,
  ICellModel,
  ICodeCellModel
} from '@jupyterlab/cells';

import {
  INotebookTracker,
  Notebook
} from '@jupyterlab/notebook';

const IPYFLOW_KERNEL_NAME: string = 'ipyflow';

/**
 * Initialization data for the jupyterlab-ipyflow extension.
 */
const extension: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-ipyflow',
  requires: [INotebookTracker],
  autoStart: true,
  activate: (
    app: JupyterFrontEnd,
    notebooks: INotebookTracker
  ) => {
    notebooks.widgetAdded.connect((sender, nbPanel) => {
      const session = nbPanel.sessionContext;
      session.ready.then(() => {
        clearCellState(nbPanel.content);
        activeCell = nbPanel.content.activeCell;
        activeCellId = nbPanel.content.activeCell.model.id;
        let commDisconnectHandler = () => {};
        if (session.session.kernel.name === IPYFLOW_KERNEL_NAME) {
          commDisconnectHandler = connectToComm(
            session,
            nbPanel.content
          );
        }
        session.kernelChanged.connect((_, args) => {
          clearCellState(nbPanel.content);
          commDisconnectHandler();
          commDisconnectHandler = () => {};
          if (args.newValue !== null && args.newValue.name === IPYFLOW_KERNEL_NAME) {
            commDisconnectHandler = connectToComm(
              session,
              nbPanel.content
            );
          }
        });
        let shouldReconnect = false;
        session.statusChanged.connect((session, status) => {
          if (status === 'restarting' || status === 'autorestarting') {
            shouldReconnect = true;
          }

          if ((status === 'idle' || status === 'busy') && shouldReconnect) {
            shouldReconnect = false;
            session.ready.then(() => {
              clearCellState(nbPanel.content);
              commDisconnectHandler();
              commDisconnectHandler = () => {};
              if (session.session.kernel.name === IPYFLOW_KERNEL_NAME) {
                commDisconnectHandler = connectToComm(
                    session,
                    nbPanel.content
                );
              }
            });
          }
        });
      });
    });
  }
};

const waitingClass = 'waiting-cell';
const readyClass = 'ready-cell';
const readyMakingClass = 'ready-making-cell';
const readyMakingInputClass = 'ready-making-input-cell';
const linkedWaitingClass = 'linked-waiting';
const linkedReadyMakerClass = 'linked-ready-maker';

let dirtyCells: Set<string> = new Set();
let waitingCells: Set<string> = new Set();
let readyCells: Set<string> = new Set();
let waiterLinks: {[id: string]: string[]} = {}
let readyMakerLinks: {[id: string]: string[]} = {}
let activeCell: Cell<ICellModel> = null;
let activeCellId: string = null;
let cellsById: {[id: string]: HTMLElement} = {};
let orderIdxById: {[id: string]: number} = {};
let cellPendingExecution: CodeCell = null;

let lastExecutionMode: string = null;
let lastExecutionHighlightsEnabled: boolean = null;
let executedReactiveReadyCells: Set<string> = new Set();
let newReadyCells: Set<string> = new Set();
let forcedReactiveCells: Set<string> = new Set();

const cleanup = new Event('cleanup');

const resetReactiveState = () => {
  newReadyCells = new Set();
  forcedReactiveCells = new Set();
  executedReactiveReadyCells = new Set();
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

const attachCleanupListener = (elem: Element, evt: "mouseover" | "mouseout", listener: any) => {
  const cleanupListener = () => {
    elem.removeEventListener(evt, listener);
    elem.removeEventListener('cleanup', cleanupListener);
  };
  elem.addEventListener(evt, listener);
  elem.addEventListener('cleanup', cleanupListener);
};

const addWaitingOutputInteraction = (elem: Element,
                                   linkedElem: Element,
                                   evt: "mouseover" | "mouseout",
                                   add_or_remove: "add" | "remove",
                                   css: string) => {
  if (elem === null || linkedElem === null) {
    return;
  }
  const listener = () => {
    linkedElem.firstElementChild.classList[add_or_remove](css);
  };
  attachCleanupListener(elem, evt, listener);
};

const addWaitingOutputInteractions = (elem: HTMLElement, linkedInputClass: string) => {
  addWaitingOutputInteraction(
      getJpInputCollapser(elem), getJpOutputCollapser(elem), 'mouseover', 'add', linkedWaitingClass
  );
  addWaitingOutputInteraction(
      getJpInputCollapser(elem), getJpOutputCollapser(elem), 'mouseout', 'remove', linkedWaitingClass
  );

  addWaitingOutputInteraction(
      getJpOutputCollapser(elem), getJpInputCollapser(elem),
      'mouseover', 'add', linkedInputClass
  );
  addWaitingOutputInteraction(
      getJpOutputCollapser(elem), getJpInputCollapser(elem),
      'mouseout', 'remove', linkedInputClass
  );
};


const refreshNodeMapping = (notebook: Notebook) => {
  cellsById = {};
  orderIdxById = {};

  notebook.widgets.forEach((cell, idx) => {
    cellsById[cell.model.id] = cell.node;
    orderIdxById[cell.model.id] = idx;
  });
}

const clearCellState = (notebook: Notebook) => {
  notebook.widgets.forEach((cell, idx) => {
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

const addUnsafeCellInteraction = (elem: Element, linkedElems: string[],
                                  cellsById: {[id: string]: HTMLElement},
                                  collapserFun: (elem: HTMLElement) => Element,
                                  evt: "mouseover" | "mouseout",
                                  add_or_remove: "add" | "remove",
                                  waitingCells: Set<string>) => {
  if (elem === null) {
    return;
  }
  const listener = () => {
    for (const linkedId of linkedElems) {
      let css = linkedReadyMakerClass;
      if (waitingCells.has(linkedId)) {
        css = linkedWaitingClass;
      }
      const collapser = collapserFun(cellsById[linkedId]);
      if (collapser === null || collapser.firstElementChild === null) {
        return;
      }
      collapser.firstElementChild.classList[add_or_remove](css);
    }
  };
  elem.addEventListener(evt, listener);
  attachCleanupListener(elem, evt, listener);
};

const connectToComm = (
  session: ISessionContext,
  notebook: Notebook
) => {
  const comm = session.session.kernel.createComm('ipyflow');
  let disconnected = false;

  const onExecution = (cell: ICellModel, args: IChangedArgs<any>) => {
    if (disconnected) {
      cell.stateChanged.disconnect(onExecution);
      return;
    }
    if (args.name !== 'executionCount' || args.newValue === null) {
      return;
    }
    const order_index_by_cell_id: {[id: string]: number} = {};
    const content_by_cell_id: {[id: string]: string} = {};
    notebook.widgets.forEach((itercell, idx) => {
      order_index_by_cell_id[itercell.model.id] = idx;
      content_by_cell_id[itercell.model.id] = itercell.model.value.text;
      if (itercell.model.id === cell.id) {
        itercell.node.classList.remove(readyClass);
        itercell.node.classList.remove(readyMakingInputClass);
      }
    });
    const payload = {
      type: 'compute_exec_schedule',
      executed_cell_id: cell.id,
      order_index_by_cell_id: order_index_by_cell_id,
      content_by_cell_id: content_by_cell_id,
    };
    comm.send(payload).done.then(() => {
      if (cellPendingExecution !== null) {
        CodeCell.execute(cellPendingExecution, session)
      } else {
        if (lastExecutionMode === 'reactive') {
          readyCells = executedReactiveReadyCells;
          updateUI(notebook);
        }
        resetReactiveState();
        comm.send({
          type: 'reactivity_cleanup',
        });
      }
    });
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
      active_cell_order_idx: newActiveCellOrderIdx
    }
    comm.send(payload);
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
    if (activeCell !== null && activeCell.model !== null) {
      if ((<ICodeCellModel>activeCell.model).isDirty) {
        dirtyCells.add(activeCellId);
      } else {
        dirtyCells.delete(activeCellId);
      }
      activeCell.model.stateChanged.disconnect(onExecution, activeCell.model.stateChanged);
    }
    activeCell = cell;
    activeCellId = cell.model.id;

    if (activeCell === null || activeCell.model === null || activeCell.model.type !== "code") {
      return;
    }

    activeCell.model.stateChanged.connect(onExecution);
    notifyActiveCell(activeCell.model);

    if (dirtyCells.has(activeCellId)) {
      const activeCellModel: any = activeCell.model as any;
      if (activeCellModel._setDirty !== undefined) {
        activeCellModel._setDirty(true);
      }
    }
    refreshNodeMapping(notebook);
    updateOneCellUI(activeCellId);
  };
  notebook.activeCellChanged.connect(onActiveCellChange);

  const actionUpdatePairs: {action: "mouseover" | "mouseout"; update: "add" | "remove"}[] = [
    {
      action: 'mouseover',
      update: 'add',
    }, {
      action: 'mouseout',
      update: 'remove',
    }
  ];

  const updateOneCellUI = (id: string) => {
    const elem = cellsById[id];
    if (waitingCells.has(id)) {
      elem.classList.add(waitingClass);
      elem.classList.add(readyClass);
      elem.classList.remove(readyMakingInputClass);
      addWaitingOutputInteractions(elem, linkedWaitingClass);
    } else if (readyCells.has(id)) {
      elem.classList.add(readyMakingInputClass);
      if (lastExecutionMode === 'normal') {
        elem.classList.add(readyClass);
        addWaitingOutputInteractions(elem, linkedReadyMakerClass);
      }
    }

    if (lastExecutionMode === 'reactive') {
      return;
    }

    if (waiterLinks.hasOwnProperty(id)) {
      actionUpdatePairs.forEach(({action, update}) => {
        addUnsafeCellInteraction(
            getJpInputCollapser(elem), waiterLinks[id], cellsById, getJpInputCollapser,
            action, update, waitingCells
        );

        addUnsafeCellInteraction(
            getJpOutputCollapser(elem), waiterLinks[id], cellsById, getJpInputCollapser,
            action, update, waitingCells,
        );
      });
    }

    if (readyMakerLinks.hasOwnProperty(id)) {
      if (!waitingCells.has(id)) {
        elem.classList.add(readyMakingClass);
        elem.classList.add(readyClass);
      }
      actionUpdatePairs.forEach(({action, update}) => {
        addUnsafeCellInteraction(
            getJpInputCollapser(elem), readyMakerLinks[id], cellsById, getJpInputCollapser,
            action, update, waitingCells
        );

        addUnsafeCellInteraction(
            getJpInputCollapser(elem), readyMakerLinks[id], cellsById, getJpOutputCollapser,
            action, update, waitingCells,
        );
      });
    }
  };

  const updateUI = (notebook: Notebook) => {
    clearCellState(notebook);
    if (!lastExecutionHighlightsEnabled) {
      return;
    }
    refreshNodeMapping(notebook);
    for (const [id] of Object.entries(cellsById)) {
      updateOneCellUI(id);
    }
  };

  comm.onMsg = (msg) => {
    if (disconnected) {
      return;
    }
    if (msg.content.data['type'] === 'establish') {
      notebook.activeCell.model.stateChanged.connect(onExecution);
      notifyActiveCell(notebook.activeCell.model);
    } else if (msg.content.data['type'] === 'compute_exec_schedule') {
      waitingCells = new Set(msg.content.data['waiting_cells'] as string[]);
      readyCells = new Set(msg.content.data['ready_cells'] as string[]);
      newReadyCells = new Set([...newReadyCells, ...msg.content.data['new_ready_cells'] as string[]]);
      forcedReactiveCells = new Set(
          [...forcedReactiveCells, ...msg.content.data['forced_reactive_cells'] as string[]]
      );
      waiterLinks = msg.content.data['waiter_links'] as { [id: string]: string[] };
      readyMakerLinks = msg.content.data['ready_maker_links'] as { [id: string]: string[] };
      cellPendingExecution = null;
      const exec_mode = msg.content.data['exec_mode'] as string;
      const flow_order = msg.content.data['flow_order'];
      const exec_schedule = msg.content.data['exec_schedule'];
      lastExecutionMode = exec_mode;
      lastExecutionHighlightsEnabled = msg.content.data['highlights_enabled'] as boolean;
      executedReactiveReadyCells.add(msg.content.data['last_executed_cell_id'] as string);
      for (const cell of notebook.widgets) {
        if (cell.model.type !== 'code' || executedReactiveReadyCells.has(cell.model.id)) {
          continue;
        }
        if (!forcedReactiveCells.has(cell.model.id)) {
          if (exec_mode !== 'reactive' || !newReadyCells.has(cell.model.id)) {
            continue;
          }
        }
        const codeCell = (cell as CodeCell);
        if (cellPendingExecution === null) {
          cellPendingExecution = codeCell;
          // break early if using one of the order-based semantics
          if (flow_order === 'in_order' || exec_schedule === 'strict') {
            break;
          }
        } else if (codeCell.model.executionCount == null) {
          // pass
        } else if (codeCell.model.executionCount < cellPendingExecution.model.executionCount) {
          // otherwise, execute in order of earliest execution counter
          cellPendingExecution = codeCell;
        }
      }
      if (cellPendingExecution === null) {
        resetReactiveState();
        updateUI(notebook);
      } else {
        onActiveCellChange(notebook, cellPendingExecution);
        clearCellState(notebook);
      }
    }
  };
  comm.open({});
  // return a disconnection handle
  return () => {
    disconnected = true;
  };
};

export default extension;
