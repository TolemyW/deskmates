# Costs

What it is: what your bots spent on model calls. The Gateway records the tokens of every run per
model and prices them from its own price table. It ignores any cost figure the agent loop reports.

Where you find it: **Costs** in the sidebar.

## The Costs screen

Pick a period: **Today**, **7 days**, **30 days**, **All time** or **Custom**. The screen shows
spend (or tokens, when nothing is priced) per day, breakdowns, and recent activity. Usage of a
model with no price row is counted as unpriced: the tokens are shown, the cost is unknown, never
zero.

Cost is fixed when the usage is recorded. Adding a price later does not re-price old usage.
Prices are set by a platform maintainer.

A run's own usage (input, output and cache tokens per model, and its attempts) is on its run
screen; see [Chats and groups](chats-and-groups.md).

## Cost alerts

The **Alerts** panel on the Costs screen lists open alerts and the alert rules.

A rule has a scope (every bot or one bot), a window (UTC day or UTC month) and one of two kinds:

- **Known cost reaches a threshold** (in USD).
- **Unpriced usage appears**: the window holds usage with no price.

A rule fires at most once per window, when a run's usage lands. An alert shows the window's known
cost and how much usage is unpriced. Anyone in the team can **Acknowledge** an alert; Admins and
Owners create and delete rules.

## What this cannot do

- A cost alert is a soft threshold, never a budget. It never stops or delays a run; no run is
  refused because of it. Enforced budgets are not part of this screen.
- Alerts appear in the product only: no email, chat or pager delivery.
- Raising a threshold after it fired does not re-arm that window; the next window starts clean.
- Totals are as good as the price table. Unpriced usage is reported as unknown, not zero.
- The turn caps of chats (see [Chats and groups](chats-and-groups.md)) stop loops; they are not
  a spending limit either. A service principal used by an external agent has its own run and
  daily cost cap; see [Using Deskmates from another agent](using-deskmates-from-another-agent.md).
