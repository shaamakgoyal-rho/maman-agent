import { create } from "zustand";

/**
 * Panel navigation for views that are not tabs.
 *
 * Configure belongs to ONE workflow, so it cannot be a tab: a tab implies a
 * place you can always go, and "configure which workflow?" has no answer
 * without a subject. It is opened from the card that needs it and closed back
 * to where the user was.
 *
 * A store rather than prop-drilling because the request originates several
 * components deep (a suggestion card) and the renderer is the panel root;
 * threading a callback through every layer between them would make the
 * intermediate components care about navigation they have nothing to do with.
 */
type NavigationStore = {
  /** The workflow being configured, or null when no sub-view is open. */
  configureWorkflowId: string | null;
  openConfigure: (workflowId: string) => void;
  closeConfigure: () => void;
};

export const useNavigation = create<NavigationStore>((set) => ({
  configureWorkflowId: null,
  openConfigure: (workflowId) => set({ configureWorkflowId: workflowId }),
  closeConfigure: () => set({ configureWorkflowId: null }),
}));
