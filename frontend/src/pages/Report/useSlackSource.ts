import { useSource } from "./useSource";

export type SlackMessage = {
  id: string;
  kind: "mention" | "dm";
  from: string;
  where: string;
  text: string;
  sentAt: string;
  url: string;
};

export const useSlackSource = () => useSource<SlackMessage>("slack", "messages");
