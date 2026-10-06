// LiveAgent 移植：crates/agent-ui/src/lib/trajectory/useConversationViewState.ts（原样复制，零改动）
import { useCallback, useState } from "react";
import {
  type ConversationViewId,
  type ConversationViewState,
  conversationViewForId,
  updateConversationViewState,
} from "./conversationViewState";

export function useConversationViewState(conversationId: string) {
  const [state, setState] = useState<ConversationViewState>(() => new Map());
  const viewForConversation = useCallback(
    (targetConversationId: string) => conversationViewForId(state, targetConversationId),
    [state],
  );
  const setConversationView = useCallback(
    (targetConversationId: string, view: ConversationViewId) => {
      setState((current) => updateConversationViewState(current, targetConversationId, view));
    },
    [],
  );
  const activeConversationView = viewForConversation(conversationId);
  const setActiveConversationView = useCallback(
    (view: ConversationViewId) => {
      setConversationView(conversationId, view);
    },
    [conversationId, setConversationView],
  );
  return {
    activeConversationView,
    setActiveConversationView,
    viewForConversation,
    setConversationView,
  };
}
