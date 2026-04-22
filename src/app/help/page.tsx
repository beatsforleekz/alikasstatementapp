'use client'

import type { ElementType, ReactNode } from 'react'
import {
  BookOpen,
  CheckCircle2,
  ClipboardList,
  FileSpreadsheet,
  FileText,
  Info,
  LifeBuoy,
  Link2,
  Mail,
  PlayCircle,
  ShieldAlert,
  Upload,
  Wrench,
} from 'lucide-react'

const workflowSteps = [
  'Set or confirm the statement period before importing.',
  'Import source files into the correct domain and period.',
  'Work through Sales Errors until rows are matched, intentionally excluded, or clearly still blocked.',
  'Check repertoire links, contract setup, work shares, and payee links before running statements.',
  'Run statements for the required domain.',
  'Review statement detail, then generate print / Excel outputs and prepare emails.',
]

const sectionCards = [
  {
    title: 'Imports',
    icon: Upload,
    body: 'Imports are the raw input for a statement period. They bring rows into the app with source, period, domain, and currency context.',
    checklist: [
      'Confirm the import is assigned to the correct statement period.',
      'Check unmatched count before moving on.',
      'Treat import data as source input, not final statement output.',
    ],
  },
  {
    title: 'Sales Errors',
    icon: ShieldAlert,
    body: 'Sales Errors is the operations queue for rows that are not ready to flow cleanly into statements.',
    checklist: [
      'Use it to find the right work or contract path.',
      'A row is only truly resolved when statement generation can allocate it.',
      'A linked contract with no usable downstream setup is still not finished.',
    ],
  },
  {
    title: 'Repertoire',
    icon: BookOpen,
    body: 'Repertoire is where works, tracks, identifiers, and work-level links live. Publishing matching depends heavily on this being correct.',
    checklist: [
      'Check ISWC and other identifiers first.',
      'Use repertoire to manage work-to-contract shares for publishing.',
      'If work shares are incomplete or over 100%, allocation will be unreliable.',
    ],
  },
  {
    title: 'Contracts',
    icon: Link2,
    body: 'Contracts hold the commercial rules used by the run engine.',
    checklist: [
      'Master contracts depend on artist share.',
      'Publishing contracts depend on income-type rates and active payee links.',
      'A contract link alone does not guarantee a payable result.',
    ],
  },
  {
    title: 'Statement Runs',
    icon: PlayCircle,
    body: 'Statement runs convert matched rows into statement records for one period and one domain at a time.',
    checklist: [
      'Master runs use matched contract + payee plus contract artist share.',
      'Publishing runs use the same allocatability rules as Sales Errors.',
      'Statement currency is locked at generation time.',
    ],
  },
  {
    title: 'Statements & Outputs',
    icon: FileText,
    body: 'The statement detail page is the review surface for one statement record. Print and Excel should reflect the same stored results.',
    checklist: [
      'Review detail before sending anything externally.',
      'Treat output drift as a shared-source issue, not a one-page fix.',
      'If one output is wrong, check the shared output path before patching locally.',
    ],
  },
  {
    title: 'Email Prep',
    icon: Mail,
    body: 'Email Prep is the communication step after the statement values are already settled.',
    checklist: [
      'Prepare email only after statement review is complete.',
      'Amounts and currency should come from the statement record.',
      'If email differs from the statement, treat that as a consistency issue.',
    ],
  },
]

const operationalRules = [
  {
    title: 'Matched',
    body: 'The row has a complete path for statement generation. For master, that means contract and payee are present. For publishing, it means the row is actually allocatable under the current work, contract, split, and payee-link rules.',
  },
  {
    title: 'Partial',
    body: 'The row is partway resolved. It may have a repertoire match or a linked contract, but the run would still skip it.',
  },
  {
    title: 'Missing contract',
    body: 'The work is known, but there is still no usable contract path for statement allocation.',
  },
  {
    title: 'Allocatable',
    body: 'The statement engine can turn the row into money on one or more statement records. This is the practical downstream test.',
  },
]

const troubleshootingItems = [
  {
    title: 'A row stays in Sales Errors after linking a contract',
    body: 'Check work shares, income-type rates, active payee links, and active splits. A linked contract with no usable allocation route stays unresolved on purpose.',
  },
  {
    title: 'The run creates zero statements',
    body: 'Usually the period has no linked imports, no matched rows, or all usable rows are blocked by missing setup or manual overrides.',
  },
  {
    title: 'Publishing totals are missing or lower than expected',
    body: 'Check the work match, publishing contract status, income-type setup, and whether work shares are null, incomplete, or over 100%.',
  },
  {
    title: 'Internal statement, export, and email do not agree',
    body: 'Treat this as a shared consistency problem. Check statement detail, output generation, and email prep together before fixing only one surface.',
  },
]

function SectionCard({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: ElementType
  children: ReactNode
}) {
  return (
    <section className="card">
      <div className="card-header">
        <div className="flex items-center gap-2">
          <Icon size={15} className="text-ops-muted" />
          <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>{title}</span>
        </div>
      </div>
      <div className="card-body space-y-3 text-sm" style={{ color: 'var(--ops-muted)' }}>
        {children}
      </div>
    </section>
  )
}

function TonePanel({
  label,
  title,
  children,
}: {
  label: string
  title: string
  children: ReactNode
}) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{
        borderColor: 'var(--ops-border)',
        background: 'var(--ops-surface-2)',
      }}
    >
      <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--ops-muted)' }}>
        {label}
      </div>
      <div className="mb-1 text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>
        {title}
      </div>
      <div className="text-sm" style={{ color: 'var(--ops-muted)' }}>
        {children}
      </div>
    </div>
  )
}

export default function HelpPage() {
  return (
    <div className="space-y-6 max-w-5xl">
      <div className="page-header">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <LifeBuoy size={18} className="text-ops-muted" />
            <h1 className="page-title">Help</h1>
          </div>
          <p className="page-subtitle">A practical guide to how this app is meant to be used from import through final statement delivery.</p>
        </div>
      </div>

      <SectionCard title="Overview" icon={Info}>
        <div className="grid gap-3 md:grid-cols-2">
          <TonePanel label="What This App Does" title="Operational statement workflow">
            Statement Ops tracks imported royalty rows, resolves matching issues, links works and contracts, generates statement records, and prepares the outputs that are sent out.
          </TonePanel>
          <TonePanel label="Most Important Rule" title="The run decides what is real">
            Imports, Sales Errors, repertoire links, and contract setup all exist to make rows genuinely allocatable before a statement run.
          </TonePanel>
        </div>
        <div
          className="rounded-lg border px-4 py-3 text-sm"
          style={{
            borderColor: 'var(--ops-border)',
            background: 'var(--ops-surface)',
            color: 'var(--ops-text)',
          }}
        >
          If you are unsure where to start, begin with the current period, check imports, clear Sales Errors, then run statements.
        </div>
      </SectionCard>

      <SectionCard title="Recommended Workflow" icon={ClipboardList}>
        <div className="grid gap-2">
          {workflowSteps.map((step, index) => (
            <div
              key={step}
              className="flex items-start gap-3 rounded-lg border px-3 py-3"
              style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}
            >
              <div
                className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold"
                style={{
                  background: 'var(--ops-surface)',
                  color: 'var(--ops-text)',
                  border: '1px solid var(--ops-border)',
                }}
              >
                {index + 1}
              </div>
              <div className="flex-1" style={{ color: 'var(--ops-text)' }}>{step}</div>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Common Operational Rules" icon={CheckCircle2}>
        <div className="grid gap-3 md:grid-cols-2">
          {operationalRules.map(rule => (
            <div
              key={rule.title}
              className="rounded-lg border p-4"
              style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}
            >
              <div className="mb-1 flex items-center gap-2">
                <FileSpreadsheet size={13} className="text-ops-muted" />
                <div className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>{rule.title}</div>
              </div>
              <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>{rule.body}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        {sectionCards.map(section => {
          const Icon = section.icon
          return (
            <SectionCard key={section.title} title={section.title} icon={Icon}>
              <p style={{ color: 'var(--ops-text)' }}>{section.body}</p>
              <div className="grid gap-2">
                {section.checklist.map(item => (
                  <div
                    key={item}
                    className="rounded-lg border px-3 py-2 text-xs"
                    style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)', color: 'var(--ops-text)' }}
                  >
                    {item}
                  </div>
                ))}
              </div>
            </SectionCard>
          )
        })}
      </div>

      <SectionCard title="Troubleshooting" icon={Wrench}>
        <div className="grid gap-3 md:grid-cols-2">
          {troubleshootingItems.map(item => (
            <div
              key={item.title}
              className="rounded-lg border p-4"
              style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}
            >
              <div className="mb-1 text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>{item.title}</div>
              <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>{item.body}</p>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  )
}
