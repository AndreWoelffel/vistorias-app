import * as React from "react";

import type { ToastActionElement, ToastProps } from "@/components/ui/toast";

const TOAST_LIMIT = 1;
const TOAST_REMOVE_DELAY = 1000000;

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
};

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
} as const;

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type ActionType = typeof actionTypes;

type Action =
  | {
      type: ActionType["ADD_TOAST"];
      toast: ToasterToast;
    }
  | {
      type: ActionType["UPDATE_TOAST"];
      toast: Partial<ToasterToast>;
    }
  | {
      type: ActionType["DISMISS_TOAST"];
      toastId?: ToasterToast["id"];
    }
  | {
      type: ActionType["REMOVE_TOAST"];
      toastId?: ToasterToast["id"];
    };

interface State {
  toasts: ToasterToast[];
}

/** Garante que nunca exista `{ toasts: undefined }` ou estado inválido vindo do listener. */
function normalizeState(state: unknown): State {
  if (state == null || typeof state !== "object") {
    return { toasts: [] };
  }
  const raw = (state as Partial<State>).toasts;
  return { toasts: Array.isArray(raw) ? raw : [] };
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({
      type: "REMOVE_TOAST",
      toastId: toastId,
    });
  }, TOAST_REMOVE_DELAY);

  toastTimeouts.set(toastId, timeout);
};

export const reducer = (state: State, action: Action): State => {
  const safeState = normalizeState(state);
  const prevToasts = Array.isArray(safeState.toasts) ? safeState.toasts : [];

  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log("[DEBUG reducer state]", safeState);
    // eslint-disable-next-line no-console
    console.log("[DEBUG reducer action]", action);
  }

  switch (action.type) {
    case "ADD_TOAST":
      return normalizeState({
        ...safeState,
        toasts: [action.toast, ...prevToasts].slice(0, TOAST_LIMIT),
      });

    case "UPDATE_TOAST": {
      const tid = action.toast?.id;
      const list = Array.isArray(prevToasts) ? prevToasts : [];
      return normalizeState({
        ...safeState,
        toasts:
          tid === undefined
            ? list
            : list.map((t) => (t.id === tid ? { ...t, ...action.toast } : t)),
      });
    }

    case "DISMISS_TOAST": {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        prevToasts.forEach((toast) => {
          addToRemoveQueue(toast.id);
        });
      }

      const list = Array.isArray(prevToasts) ? prevToasts : [];
      return normalizeState({
        ...safeState,
        toasts: list.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t,
        ),
      });
    }
    case "REMOVE_TOAST":
      if (action.toastId === undefined) {
        return normalizeState({
          ...safeState,
          toasts: [],
        });
      }
      return normalizeState({
        ...safeState,
        toasts: (Array.isArray(prevToasts) ? prevToasts : []).filter((t) => t.id !== action.toastId),
      });
    default:
      return normalizeState({ ...safeState, toasts: prevToasts });
  }
};

const listeners: Array<(state: State) => void> = [];

let memoryState: State = { toasts: [] };

function dispatch(action: Action) {
  try {
    memoryState = normalizeState(reducer(normalizeState(memoryState), action));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[DEBUG toast dispatch] erro no reducer — resetando toasts", e);
    memoryState = { toasts: [] };
  }
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

type Toast = Omit<ToasterToast, "id">;

function toast({ ...props }: Toast) {
  const id = genId();

  const update = (props: ToasterToast) =>
    dispatch({
      type: "UPDATE_TOAST",
      toast: { ...props, id },
    });
  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id });

  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  return {
    id: id,
    dismiss,
    update,
  };
}

function useToast() {
  const [state, setState] = React.useState<State>(() => normalizeState(memoryState));

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, []);

  const normalized = normalizeState(state);

  return {
    ...normalized,
    toasts: Array.isArray(normalized.toasts) ? normalized.toasts : [],
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  };
}

export { useToast, toast };
