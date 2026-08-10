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
  /**
   * Whether the demonstration view is open.
   *
   * Teaching by demonstration used to be a TAB, which was the wrong shape for
   * it twice over. A tab is a place you browse, and this is a thing you do at a
   * moment — the moment Maman admits it cannot verify a workflow because it
   * never saw which fields the work touches. And a tab implies somewhere worth
   * visiting, when an empty demonstration view has nothing to offer: there is no
   * workflow in question and nothing to be shown.
   *
   * So it opens from the card that needs it, like Configure, and closes back to
   * where the user was.
   */
  teachOpen: boolean;
  openTeach: () => void;
  closeTeach: () => void;
};

export const useNavigation = create<NavigationStore>((set) => ({
  configureWorkflowId: null,
  openConfigure: (workflowId) => set({ configureWorkflowId: workflowId, teachOpen: false }),
  closeConfigure: () => set({ configureWorkflowId: null }),
  teachOpen: false,
  // The two sub-views are mutually exclusive: both take over the content area,
  // and one silently sitting behind the other is a view the user cannot get back
  // to without knowing it is there.
  openTeach: () => set({ teachOpen: true, configureWorkflowId: null }),
  closeTeach: () => set({ teachOpen: false }),
}));
