import { describe, expect, it } from "vitest";
import { rank, score, toItems } from "./rank";
import type { JiraIssue } from "./jira";
import type { GitHubIssue, SlackMessage } from "./sources";

const slack = (id: string, kind: SlackMessage["kind"], sentAt: string): SlackMessage => ({ id, kind, from: "Riley", where: kind === "dm" ? "Direct message" : "#build", text: "hi", sentAt, url: "" });
const github = (id: string, kind: GitHubIssue["kind"], updatedAt: string): GitHubIssue => ({ id, kind, repository: "team/repo", number: 1, title: "t", state: "open", updatedAt, url: "" });
const jira = (key: string, status: string, sprints: string[], updated: string | null): JiraIssue => ({ key, summary: "s", status, issueType: "Task", updated, url: "", description: "", sprints, labels: [], storyPointEstimate: null, reporter: "" });

const order = (lists: Parameters<typeof toItems>[0]) => rank(toItems(lists)).map((item) => item.key);

describe("rank", () => {
  it("puts DMs and pull requests first, then started Jira work, then the sprint, then mentions, then the backlog", () => {
    expect(order({
      slack: [slack("m", "mention", "2026-10-20T12:00:00Z"), slack("d", "dm", "2026-10-20T08:00:00Z")],
      jira: [jira("J-1", "To Do", [], "2026-10-20T12:00:00Z"), jira("J-2", "To Do", ["Sprint 4"], "2026-10-20T12:00:00Z"), jira("J-3", "In Progress", ["Sprint 4"], "2026-10-19T12:00:00Z")],
      github: [github("pr", "pull_request", "2026-10-18T12:00:00Z")],
    })).toEqual(["slack:d", "github:pr", "jira:J-3", "jira:J-2", "slack:m", "jira:J-1"]);
  });

  it("breaks ties by the newest activity", () => {
    expect(order({
      slack: [slack("old", "dm", "2026-10-19T12:00:00Z"), slack("new", "dm", "2026-10-20T12:00:00Z")],
      jira: [],
      github: [github("pr", "pull_request", "2026-10-20T09:00:00Z")],
    })).toEqual(["slack:new", "github:pr", "slack:old"]);
  });

  it("counts Jira review statuses as started and a GitHub issue with the sprint", () => {
    const [review, issue] = toItems({ slack: [], jira: [jira("J-1", "In Review", [], null)], github: [github("i", "issue", "2026-10-20T12:00:00Z")] });
    expect(score(review)).toBe(3);
    expect(score(issue)).toBe(2);
  });

  it("does not change the list it is given", () => {
    const items = toItems({ slack: [slack("m", "mention", "2026-10-20T12:00:00Z"), slack("d", "dm", "2026-10-20T08:00:00Z")], jira: [], github: [] });
    rank(items);
    expect(items.map((item) => item.key)).toEqual(["slack:m", "slack:d"]);
  });
});
