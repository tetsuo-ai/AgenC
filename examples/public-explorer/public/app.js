const state = {
  snapshot: null,
  stream: null,
};

const statsGrid = document.getElementById('stats-grid');
const tasksList = document.getElementById('tasks-list');
const disputesList = document.getElementById('disputes-list');
const agentsTable = document.getElementById('agents-table');
const eventsList = document.getElementById('events-list');
const connectionStatus = document.getElementById('connection-status');
const connectionDetail = document.getElementById('connection-detail');
const programId = document.getElementById('program-id');
const rpcUrl = document.getElementById('rpc-url');
const refreshTime = document.getElementById('refresh-time');
const taskSummary = document.getElementById('task-summary');
const disputeSummary = document.getElementById('dispute-summary');
const agentSummary = document.getElementById('agent-summary');

const statCards = [
  {
    key: 'taskCount',
    label: 'Tasks',
    detail: (stats) => `${stats.openTaskCount} open`,
  },
  {
    key: 'disputeCount',
    label: 'Disputes',
    detail: (stats) => `${stats.activeDisputeCount} active`,
  },
  {
    key: 'agentCount',
    label: 'Agents',
    detail: (stats) => `${stats.activeAgentCount} active`,
  },
  {
    key: 'totalSolRewards',
    label: 'Visible rewards',
    detail: (stats) => `${stats.privateTaskCount} private tasks omitted`,
  },
  {
    key: 'totalEventsObserved',
    label: 'Observed events',
    detail: () => 'Since explorer startup',
  },
];

const COPY_ICON = `
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path
      d="M7.5 6.667V5.833c0-1.38 1.12-2.5 2.5-2.5h4.167c1.38 0 2.5 1.12 2.5 2.5V10c0 1.38-1.12 2.5-2.5 2.5h-.833"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <rect
      x="3.333"
      y="6.667"
      width="9.167"
      height="10"
      rx="2"
      stroke="currentColor"
      stroke-width="1.5"
    />
  </svg>
  <span class="sr-only">Copy address</span>
`;

const COPIED_ICON = `
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path
      d="m4.167 10.417 3.333 3.333L15.833 5.417"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
  <span class="sr-only">Copied</span>
`;

const ERROR_ICON = `
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path
      d="M6.25 6.25 13.75 13.75M13.75 6.25 6.25 13.75"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
    />
  </svg>
  <span class="sr-only">Copy failed</span>
`;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shortAddress(value) {
  if (!value) return '-';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function renderTokenAmount(value) {
  const text = String(value ?? '-');
  const match = text.match(/^([0-9.,]+)\s+([A-Z]{2,6})$/);
  if (!match) return escapeHtml(text);
  return `
    <span class="token-amount">
      <span class="token-figure">${escapeHtml(match[1])}</span>
      <span class="token-unit">${escapeHtml(match[2])}</span>
    </span>
  `;
}

function renderTokenFigure(value) {
  const text = String(value ?? '-');
  const match = text.match(/^([0-9.,]+)\s+([A-Z]{2,6})$/);
  return escapeHtml(match ? match[1] : text);
}

function renderCapabilities(capabilities) {
  const values = capabilities?.length ? capabilities : ['None'];
  return `
    <div class="capability-list">
      ${values
        .map((capability) => `<span class="capability-chip">${escapeHtml(capability)}</span>`)
        .join('')}
    </div>
  `;
}

function renderAgentIdentity(agent) {
  return `
    <div class="agent-identity">
      <button
        class="copy-trigger agent-copy-trigger"
        type="button"
        data-copy="${escapeHtml(agent.pda)}"
        data-copy-label="agent"
        aria-label="Copy agent address"
        title="Copy agent address"
      >
        ${COPY_ICON}
      </button>
      <div class="table-primary" title="${escapeHtml(agent.pda)}">${escapeHtml(agent.shortPda)}</div>
      <div class="table-secondary">${escapeHtml(shortAddress(agent.authority))}</div>
    </div>
  `;
}

function renderCopyableAddress(value, label) {
  if (!value) {
    return '<strong class="detail-value detail-value-mono">-</strong>';
  }

  return `
    <div class="copy-inline">
      <strong class="detail-value detail-value-mono detail-value-copy" title="${escapeHtml(value)}">${escapeHtml(shortAddress(value))}</strong>
      <button
        class="copy-trigger"
        type="button"
        data-copy="${escapeHtml(value)}"
        data-copy-label="${escapeHtml(label)}"
        aria-label="Copy ${escapeHtml(label)} address"
        title="Copy full address"
      >
        ${COPY_ICON}
      </button>
    </div>
  `;
}

function relativeTime(input) {
  const value = typeof input === 'number' ? input : Date.parse(input);
  if (Number.isNaN(value)) return '-';
  const deltaMs = value - Date.now();
  const deltaSeconds = Math.round(deltaMs / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(deltaSeconds) >= size || unit === 'second') {
      return formatter.format(Math.round(deltaSeconds / size), unit);
    }
  }
  return '-';
}

function statusClass(value) {
  const lower = String(value).toLowerCase();
  if (lower.includes('open') || lower.includes('completed') || lower.includes('active')) {
    return 'tone-teal';
  }
  if (lower.includes('dispute') || lower.includes('pending')) {
    return 'tone-orange';
  }
  if (lower.includes('cancel') || lower.includes('expired') || lower.includes('deregister')) {
    return 'tone-rose';
  }
  return 'tone-ink';
}

function eventAccent(accent) {
  switch (accent) {
    case 'teal':
      return 'tone-teal';
    case 'orange':
      return 'tone-orange';
    case 'rose':
      return 'tone-rose';
    default:
      return 'tone-ink';
  }
}

function renderStats(snapshot) {
  statsGrid.innerHTML = statCards
    .map((card) => {
      const value = snapshot.stats[card.key];
      return `
        <article class="stat-card">
          <span class="stat-label">${escapeHtml(card.label)}</span>
          <strong class="stat-value">${escapeHtml(value)}</strong>
          <span class="stat-detail">${escapeHtml(card.detail(snapshot.stats))}</span>
        </article>
      `;
    })
    .join('');
}

function renderTasks(snapshot) {
  taskSummary.textContent = `${snapshot.tasks.length} shown`;
  if (!snapshot.tasks.length) {
    tasksList.className = 'stack-list empty-state';
    tasksList.textContent = 'No tasks available yet.';
    return;
  }
  tasksList.className = 'stack-list';
  tasksList.innerHTML = snapshot.tasks
    .map((task) => {
      const created = task.createdAtIso ? relativeTime(task.createdAtIso) : 'Unknown';
      const deadline = task.deadlineIso ? relativeTime(task.deadlineIso) : 'No deadline';
      return `
        <article class="stack-card stack-card-task">
          <div class="card-topline">
            <span class="mono-pill">Task ${escapeHtml(task.shortId)}</span>
            <div class="badge-row">
              <span class="badge ${statusClass(task.status)}">${escapeHtml(task.status)}</span>
              <span class="badge tone-ink">${escapeHtml(task.taskType)}</span>
            </div>
          </div>
          <h3>${escapeHtml(task.description)}</h3>
          <div class="detail-grid task-grid">
            <div class="detail-cell detail-cell-emphasis">
              <span class="detail-label">Reward</span>
              <strong class="detail-value detail-value-strong">${renderTokenAmount(task.reward)}</strong>
            </div>
            <div class="detail-cell">
              <span class="detail-label">Worker slots</span>
              <strong class="detail-value">${escapeHtml(task.currentWorkers)} / ${escapeHtml(task.maxWorkers)}</strong>
            </div>
            <div class="detail-cell">
              <span class="detail-label">Creator</span>
              <strong class="detail-value detail-value-mono">${escapeHtml(shortAddress(task.creator))}</strong>
            </div>
          </div>
          <div class="entity-strip card-rail">
            <div class="entity-item">
              <span class="detail-label">Created</span>
              <strong class="detail-inline">${escapeHtml(created)}</strong>
            </div>
            <div class="entity-item">
              <span class="detail-label">Deadline</span>
              <strong class="detail-inline">${escapeHtml(deadline)}</strong>
            </div>
            ${
              task.privateTask
                ? '<div class="entity-item entity-item-tag"><span class="privacy-pill">Private proof task</span></div>'
                : ''
            }
          </div>
        </article>
      `;
    })
    .join('');
}

function renderDisputes(snapshot) {
  disputeSummary.textContent = `${snapshot.stats.activeDisputeCount} active`;
  if (!snapshot.disputes.length) {
    disputesList.className = 'stack-list empty-state';
    disputesList.textContent = 'No disputes on the observed surface.';
    return;
  }
  disputesList.className = 'stack-list';
  disputesList.innerHTML = snapshot.disputes
    .map((dispute) => {
      return `
        <article class="stack-card stack-card-dispute">
          <div class="card-topline">
            <span class="mono-pill">Case ${escapeHtml(dispute.shortId)}</span>
            <span class="badge ${statusClass(dispute.status)}">${escapeHtml(dispute.status)}</span>
          </div>
          <h3>${escapeHtml(dispute.resolutionType)} resolution</h3>
          <div class="entity-strip dispute-parties">
            <div class="entity-item">
              <span class="detail-label">Initiator</span>
              ${renderCopyableAddress(dispute.initiator, 'initiator')}
            </div>
            <div class="entity-item">
              <span class="detail-label">Defendant</span>
              ${renderCopyableAddress(dispute.defendant, 'defendant')}
            </div>
          </div>
          <div class="detail-grid dispute-grid">
            <div class="detail-cell">
              <span class="detail-label">Votes for</span>
              <strong class="detail-value">${escapeHtml(dispute.votesFor)}</strong>
            </div>
            <div class="detail-cell">
              <span class="detail-label">Votes against</span>
              <strong class="detail-value">${escapeHtml(dispute.votesAgainst)}</strong>
            </div>
            <div class="detail-cell">
              <span class="detail-label">Voters</span>
              <strong class="detail-value">${escapeHtml(dispute.totalVoters)}</strong>
            </div>
            <div class="detail-cell detail-cell-warning">
              <span class="detail-label">Deadline</span>
              <strong class="detail-value">${escapeHtml(relativeTime(dispute.votingDeadlineIso))}</strong>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderAgents(snapshot) {
  agentSummary.textContent = `${snapshot.stats.activeAgentCount} active`;
  if (!snapshot.agents.length) {
    agentsTable.className = 'table-shell empty-state';
    agentsTable.textContent = 'No agents registered yet.';
    return;
  }
  agentsTable.className = 'table-shell';
  agentsTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Agent</th>
          <th>Status</th>
          <th>Reputation</th>
          <th>Completed</th>
          <th>Stake (SOL)</th>
          <th>Capabilities</th>
        </tr>
      </thead>
      <tbody>
        ${snapshot.agents
          .map(
            (agent) => `
              <tr>
                <td>
                  ${renderAgentIdentity(agent)}
                </td>
                <td><span class="badge ${statusClass(agent.status)}">${escapeHtml(agent.status)}</span></td>
                <td>${escapeHtml(agent.reputationPercent)}</td>
                <td>${escapeHtml(agent.tasksCompleted)}</td>
                <td class="stake-cell">${renderTokenFigure(agent.stake)}</td>
                <td class="capability-cell">${renderCapabilities(agent.capabilities)}</td>
              </tr>
            `,
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function renderEvents(snapshot) {
  refreshTime.textContent = `Updated ${relativeTime(snapshot.meta.updatedAtIso)}`;
  if (!snapshot.events.length) {
    eventsList.className = 'event-list empty-state';
    eventsList.textContent = 'Waiting for protocol events...';
    return;
  }
  eventsList.className = 'event-list';
  eventsList.innerHTML = snapshot.events
    .map(
      (event) => `
        <article class="event-item">
          <div class="event-dot ${eventAccent(event.accent)}"></div>
          <div class="event-copy">
            <div class="event-title-row">
              <strong>${escapeHtml(event.title)}</strong>
              <span>${escapeHtml(relativeTime(event.timestampIso))}</span>
            </div>
            <p>${escapeHtml(event.detail)}</p>
          </div>
        </article>
      `,
    )
    .join('');
}

function render(snapshot) {
  state.snapshot = snapshot;
  programId.textContent = shortAddress(snapshot.meta.programId);
  programId.title = snapshot.meta.programId;
  rpcUrl.textContent = snapshot.meta.rpcUrl;
  rpcUrl.title = snapshot.meta.rpcUrl;
  renderStats(snapshot);
  renderTasks(snapshot);
  renderDisputes(snapshot);
  renderAgents(snapshot);
  renderEvents(snapshot);
}

function setConnection(ok, message) {
  connectionStatus.textContent = ok ? 'Live' : 'Degraded';
  connectionStatus.className = ok ? 'status-live' : 'status-stale';
  connectionDetail.textContent = message;
}

async function bootstrap() {
  const response = await fetch('/api/bootstrap');
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || 'Bootstrap failed');
  }
  render(data.snapshot);
  setConnection(!data.lastError, data.lastError || 'Snapshot loaded');
}

function openStream() {
  const stream = new EventSource('/api/events');
  state.stream = stream;

  stream.onopen = () => {
    setConnection(true, 'Realtime stream connected');
  };

  stream.onmessage = (message) => {
    const envelope = JSON.parse(message.data);
    if (envelope.type === 'snapshot') {
      render(envelope.payload);
      setConnection(true, 'Realtime stream connected');
      return;
    }
    if (envelope.type === 'event') {
      if (!state.snapshot) return;
      state.snapshot.events = [envelope.payload, ...(state.snapshot.events || [])].slice(0, 80);
      renderEvents(state.snapshot);
      return;
    }
    if (envelope.type === 'health') {
      setConnection(envelope.payload.ok, envelope.payload.message);
    }
  };

  stream.onerror = () => {
    setConnection(false, 'Realtime stream reconnecting...');
  };
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy-trigger');
  if (!button) return;

  const value = button.dataset.copy;
  if (!value) return;

  const copyLabel = button.dataset.copyLabel || 'address';

  const resetLabel = () => {
    button.innerHTML = COPY_ICON;
    button.setAttribute('aria-label', `Copy ${copyLabel} address`);
    button.setAttribute('title', 'Copy full address');
    button.classList.remove('is-copied', 'is-error');
  };

  try {
    await navigator.clipboard.writeText(value);
    button.innerHTML = COPIED_ICON;
    button.setAttribute('aria-label', `Copied ${copyLabel} address`);
    button.setAttribute('title', 'Copied');
    button.classList.remove('is-error');
    button.classList.add('is-copied');
  } catch {
    button.innerHTML = ERROR_ICON;
    button.setAttribute('aria-label', `Failed to copy ${copyLabel} address`);
    button.setAttribute('title', 'Copy failed');
    button.classList.remove('is-copied');
    button.classList.add('is-error');
  }

  window.setTimeout(resetLabel, 1400);
});

bootstrap()
  .catch((error) => {
    setConnection(false, error.message || 'Unable to load explorer');
  })
  .finally(() => {
    openStream();
  });
