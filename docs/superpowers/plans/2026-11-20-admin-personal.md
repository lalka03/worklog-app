# Admin Personal Worklog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow administrators to edit their own shifts while viewing employees separately.

**Architecture:** Keep personal DB and employee read-only data separate. Pass explicit settings/data to calculation and display helpers; use a separate employee selection and month. Keep write authorization based on authenticated UID, never on whether an employee is selected.

**Tech Stack:** Capacitor, vanilla JS, Firebase RTDB, Node test runner.

**Spec:** docs/superpowers/specs/2026-11-20-admin-personal-design.md

## Global Constraints

- Test branch worklog-multiuser-test only; app ID com.worklog.app.test and test Firebase unchanged.
- No writes to other employees or client-managed roles.
- Existing personal editing and cache behavior unchanged.

## Review Focus

- Role unresolved or logout: no writes and no admin tab.
- Admin selecting employee with different rates: calculate with employee rates, never alter personal DB.
- Empty employee list or records: display an empty state.
- Refresh after leaving employee tab or switching accounts: no stale data or navigation.
- Ordinary user cannot select employees or read their list.

## Task 1: account and data authorization

Files: account.js, index.html, database.rules.json, test/account.test.cjs, test/account-integration.test.cjs.

- [ ] Write failing tests: administrator own save uses only users/admin/worklog, admin can see other accounts, logout removes role and data, unresolved role rejects writes.
- [ ] Run `npm test`, expect new assertions fail.
- [ ] Allow known authenticated roles to write own scoped data. Initialize personal sync for all users; fetch employee list separately. Rules enforce auth.uid === $uid for profile/worklog and preserve role read-only.
- [ ] Run `npm test`, expect all pass.

## Task 2: read-only employee screen

Files: index.html, test/account-integration.test.cjs, README.md.

- [ ] Write failing tests for dedicated admin tab, other employee monthly summary and totals using its settings, own data unaffected, stale refresh and non-admin access rejected.
- [ ] Run `npm test`, expect new tests fail.
- [ ] Add admin-only tab and separate employee state. Reuse pure renderHome/renderTotals with explicit data and month; use direct read-only day detail markup, never bind personal editing to employee UI. Reset employee state on log out.
- [ ] Run `npm test`, expect all pass. Review rules and diff, document deployment and commit both tasks atomically on test branch.
- [ ] Verify GitHub Actions build for new commit; publish updated rules only after explicit confirmation in Firebase test project.
