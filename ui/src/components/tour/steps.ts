// Authored by Tomás Neto (TN 2026)
import type { Placement } from './position';

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** `data-tour` value of the element to spotlight; none = a centred card */
  target?: string;
  /** route to open before looking for the target */
  route?: '/' | '/keys' | '/messages' | '/approvals' | '/activity' | '/roles';
  placement?: Placement;
  /** shown when the user holds ANY of these permissions (none = everyone) */
  perms?: string[];
}

/**
 * The tour follows a message's life: the gateway's state, the keys that send, the guardrails, the
 * record of every request, then the people who run it. Steps the user cannot reach are left out.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: 'intro',
    title: 'How mail-gateway works',
    body: 'Apps and LLM agents send email through this gateway instead of talking to the relay directly. Each one gets a key with its own policy, and every request is recorded. This tour shows where each part lives.',
  },
  {
    id: 'signal',
    target: 'gateway-signal',
    placement: 'right',
    title: 'The signal light',
    body: 'Always in view. Green: sends are accepted and delivered. Amber: an admin paused the gateway. Red: a provider’s circuit breaker tripped and paused it.',
    perms: ['dashboard:read'],
  },
  {
    id: 'gateway',
    route: '/',
    target: 'gateway-state',
    title: 'Stop everything in one click',
    body: 'If a key misbehaves, Pause rejects every new send with GATEWAY_PAUSED and holds the queue. Resume picks up where it stopped. Breaker and relay health sit next to it.',
    perms: ['dashboard:read'],
  },
  {
    id: 'traffic',
    route: '/',
    target: 'traffic',
    placement: 'top',
    title: 'Traffic',
    body: 'Delivered mail sits above the line, sends stopped by the guardrails below it. A run of red underneath usually means an agent is looping or a policy is too tight.',
    perms: ['dashboard:read'],
  },
  {
    id: 'keys',
    route: '/keys',
    target: 'page-actions',
    placement: 'left',
    title: 'One key per app or agent',
    body: 'New keys start in sandbox: mail is captured by Mailpit and never reaches a real inbox. The secret is shown once, only a hash is stored.',
    perms: ['keys:create'],
  },
  {
    id: 'policy',
    route: '/keys',
    target: 'table',
    title: 'A policy on every key',
    body: 'Open a key to set its sender, allow-list, quotas and mode. Promote sandbox → approval → live only when the allow-list and quotas are tight.',
    perms: ['keys:read'],
  },
  {
    id: 'messages',
    route: '/messages',
    target: 'filters',
    title: 'Every request, recorded',
    body: 'Accepted or rejected, each request after authentication lands here with its reason code. Open a row to see the route it took and the provider’s response.',
    perms: ['messages:read'],
  },
  {
    id: 'approvals',
    route: '/approvals',
    target: 'nav-approvals',
    placement: 'right',
    title: 'Approvals',
    body: 'Keys in approval mode hold their mail here until someone with the permission approves it. Approved mail goes out live; the count shows what is waiting.',
    perms: ['messages:read'],
  },
  {
    id: 'activity',
    route: '/activity',
    target: 'table',
    title: 'Activity log',
    body: 'Every admin action and sign-in: who, what, when and from where. Filter by actor or key and export it as CSV for audits.',
    perms: ['audit:read'],
  },
  {
    id: 'roles',
    route: '/roles',
    target: 'table',
    title: 'Roles and permissions',
    body: 'Access comes from roles built from permissions, and a user can hold several. For SSO users, Authentik groups map onto these roles.',
    perms: ['users:read', 'roles:manage'],
  },
  {
    id: 'search',
    target: 'search',
    placement: 'right',
    title: 'Jump anywhere',
    body: 'Press ⌘K or Ctrl K to go to a page or pause the gateway. Two-key shortcuts work too: g then k for keys, g then m for messages.',
  },
  {
    id: 'done',
    target: 'user-menu',
    placement: 'right',
    title: 'That’s the tour',
    body: 'Restart it from your account menu at any time. Developers integrating an app will find the API reference under API docs.',
  },
];
