// The Slack channel that receives insights reports.
//
// Its own credential, deliberately not the alert webhook: "alert my incident
// channel about failures" and "post the weekly report to #qa" are different
// destinations more often than the same one, and one URL doing both jobs
// makes turning one feature off turn both off. Same encrypted-store shape as
// the alert webhook — the factory is the guarantee they cannot drift.
//
// An INCOMING webhook is channel-bound on Slack's side, so "send it to a
// specific channel" is exactly "paste that channel's webhook URL here".

import { createWebhookUrlStore, type WebhookUrlStore } from "../webhook-url-store.js";

export const insightsSlackUrlStore: WebhookUrlStore = createWebhookUrlStore(
  "insights-slack-webhook.bin",
  "insights Slack webhook",
);
