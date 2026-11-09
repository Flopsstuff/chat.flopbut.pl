import type { User } from 'firebase/auth';
import { type FormEvent, useState } from 'react';
import { type AboutAnswers, saveAbout } from './api';

// A short form shown once, after the invite and before the chat: who the member is, so the bot
// can answer to the point. Everything is optional, and it can be skipped.

const ROLES = [
  { value: 'agency-recruiter', label: 'Recruiter / HR at an agency' },
  { value: 'company-recruiter', label: 'Recruiter / HR at the company' },
  { value: 'hiring-manager', label: 'Hiring manager / tech lead' },
  { value: 'founder', label: 'Founder / CEO' },
  { value: 'acquaintance', label: 'Colleague or friend of Flop' },
  { value: 'other', label: 'Other' },
];

const POSITIONS = [
  { value: 'tech-lead', label: 'Tech Lead' },
  { value: 'head-of-mobile', label: 'Head of Mobile' },
  { value: 'solution-architect', label: 'Solution Architect' },
  { value: 'senior-engineer', label: 'Senior iOS / React Native' },
  { value: 'exploring', label: 'Just getting to know him' },
];

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'pl', label: 'Polski' },
  { value: 'ru', label: 'Русский' },
  { value: '', label: 'Other' },
];

const NAME_LENGTH = 60;
const COMPANY_LENGTH = 80;

export function About({
  user,
  name: googleName,
  onDone,
}: {
  user: User;
  name: string | null;
  onDone: () => void;
}) {
  const [role, setRole] = useState<string | null>(null);
  const [name, setName] = useState(googleName ?? '');
  const [company, setCompany] = useState('');
  const [positions, setPositions] = useState<string[]>([]);
  const [language, setLanguage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(answers: AboutAnswers) {
    setBusy(true);
    setError(null);
    try {
      await saveAbout(user, answers);
      onDone();
    } catch {
      setError('Could not save that. Try again in a moment.');
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    send({
      role,
      name,
      company,
      positions,
      language: language || null,
    });
  }

  const toggle = (value: string) =>
    setPositions((list) =>
      list.includes(value) ? list.filter((p) => p !== value) : [...list, value],
    );

  return (
    <main className="placeholder about">
      <p className="eyebrow">chat.flopbut.pl</p>
      <h1>A few words about you</h1>
      <p className="lead">
        So Flop's assistant can answer to the point. Twenty seconds, and every question is optional.
      </p>
      <form className="about-form" onSubmit={submit}>
        <fieldset>
          <legend>Who are you?</legend>
          <Chips
            options={ROLES}
            selected={role ? [role] : []}
            onPick={(v) => setRole(v === role ? null : v)}
          />
        </fieldset>

        <label>
          <span>What should we call you?</span>
          <input
            value={name}
            maxLength={NAME_LENGTH}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label>
          <span>Company</span>
          <input
            value={company}
            maxLength={COMPANY_LENGTH}
            autoComplete="organization"
            placeholder="Optional"
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>

        <fieldset>
          <legend>Which roles are you looking at?</legend>
          <Chips options={POSITIONS} selected={positions} onPick={toggle} />
        </fieldset>

        <fieldset>
          <legend>Language for the chat</legend>
          <Chips
            options={LANGUAGES}
            selected={language === null ? [] : [language]}
            onPick={(v) => setLanguage(v === language ? null : v)}
          />
        </fieldset>

        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="button primary" disabled={busy}>
            Continue
          </button>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => send({ skip: true })}
          >
            Skip
          </button>
        </div>
      </form>
    </main>
  );
}

function Chips({
  options,
  selected,
  onPick,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onPick: (value: string) => void;
}) {
  return (
    <div className="chips">
      {options.map((option) => (
        <button
          key={option.value || option.label}
          type="button"
          className="chip"
          aria-pressed={selected.includes(option.value)}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
