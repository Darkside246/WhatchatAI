import { BarChart3, MapPin, PhoneIncoming, PhoneMissed, PhoneOutgoing, Radio, UserRound, Video } from 'lucide-react';
import type { StructuredMessagePayload } from '../lib/api.js';

/**
 * Renders the real content of the WhatsApp message types that carry
 * something other than text or downloadable media.
 *
 * These used to show as a bare type label - the operator could see that "a
 * location" had arrived but never where, or that "a poll" had arrived but
 * never what it asked. Everything here comes from what WhatsApp actually
 * sent; nothing is defaulted, geocoded, or inferred. When a field is
 * genuinely absent it is simply not shown rather than filled with a
 * placeholder.
 */

/** Pulls a display name and phone numbers out of a vCard. Contacts arrive as raw vCard text - this reads it rather than guessing. */
function parseVCard(vcard: string | null): { name: string | null; phones: string[] } {
  if (!vcard) return { name: null, phones: [] };

  const name =
    /^FN[^:]*:(.+)$/im.exec(vcard)?.[1]?.trim() ??
    // N is structured as Family;Given;Middle;Prefix;Suffix - the useful,
    // human-readable order is Given then Family.
    (() => {
      const parts = /^N[^:]*:(.+)$/im.exec(vcard)?.[1]?.split(';').map((part) => part.trim()) ?? [];
      const composed = [parts[1], parts[0]].filter((part) => part && part.length > 0).join(' ');
      return composed.length > 0 ? composed : null;
    })();

  const phones = [...vcard.matchAll(/^TEL[^:]*:(.+)$/gim)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((phone) => phone.length > 0);

  return { name, phones: [...new Set(phones)] };
}

function LocationCard({ payload }: { payload: Extract<StructuredMessagePayload, { kind: 'location' }> }) {
  // A plain geo query against OpenStreetMap - opened by the operator in a new
  // tab, never embedded, so the page itself makes no third-party request and
  // the customer's coordinates are not handed to a map provider just by
  // viewing the conversation.
  const mapUrl = `https://www.openstreetmap.org/?mlat=${payload.latitude}&mlon=${payload.longitude}#map=16/${payload.latitude}/${payload.longitude}`;

  return (
    <div className="mt-1 rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <div className="flex items-start gap-2">
        {payload.isLive ? (
          <Radio size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        ) : (
          <MapPin size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="text-caption font-medium text-fg">{payload.isLive ? 'Live location' : 'Location'}</p>
          {payload.name && <p className="text-caption text-fg-secondary">{payload.name}</p>}
          {payload.address && <p className="text-meta text-fg-muted">{payload.address}</p>}
          <p className="mt-1 text-meta tabular-nums text-fg-muted">
            {payload.latitude.toFixed(5)}, {payload.longitude.toFixed(5)}
          </p>
          <a
            href={mapUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 inline-block text-meta font-medium text-accent hover:underline"
          >
            Open in maps
          </a>
        </div>
      </div>
    </div>
  );
}

function ContactsCard({ payload }: { payload: Extract<StructuredMessagePayload, { kind: 'contacts' }> }) {
  return (
    <div className="mt-1 space-y-1.5">
      {payload.contacts.map((contact, index) => {
        const parsed = parseVCard(contact.vcard);
        const name = contact.displayName ?? parsed.name;
        return (
          <div key={`${name ?? 'contact'}-${index}`} className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
            <div className="flex items-start gap-2">
              <UserRound size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              <div className="min-w-0">
                <p className="truncate text-caption font-medium text-fg">{name ?? 'Shared contact'}</p>
                {parsed.phones.map((phone) => (
                  <a key={phone} href={`tel:${phone.replace(/\s+/g, '')}`} className="block text-meta text-accent hover:underline">
                    {phone}
                  </a>
                ))}
                {/* No name and no number means WhatsApp sent a card we cannot
                    read - said plainly rather than rendered as an empty box. */}
                {!name && parsed.phones.length === 0 && (
                  <p className="text-meta text-fg-muted">No readable details in this contact card.</p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PollCard({ payload }: { payload: Extract<StructuredMessagePayload, { kind: 'poll' }> }) {
  return (
    <div className="mt-1 rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <div className="flex items-start gap-2">
        <BarChart3 size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-caption font-medium text-fg">{payload.question ?? 'Poll'}</p>
          <ul className="mt-1.5 space-y-1">
            {payload.options.map((option) => (
              <li key={option} className="rounded-md bg-surface-3 px-2 py-1 text-meta text-fg-secondary">
                {option}
              </li>
            ))}
          </ul>
          {/* Vote counts are deliberately absent: WhatsApp encrypts poll
              votes end-to-end per voter, so this client genuinely does not
              know the tally. Showing a made-up or zeroed count would be
              worse than showing none. */}
          {payload.selectableCount !== null && payload.selectableCount > 1 && (
            <p className="mt-1.5 text-meta text-fg-muted">Select up to {payload.selectableCount}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A call WhatsApp logged in the conversation.
 *
 * The words come from the server, which is the only side that knows which
 * direction the call went - the same envelope is "Missed voice call" for a
 * customer's call and "No answer" for ours, and deciding that here would mean
 * keeping a second copy of the rule in sync with the first. The payload is
 * used for what it genuinely settles on its own: which icon, and the
 * duration.
 *
 * A missed call is tinted because it is the one outcome that is a job: a
 * customer tried to reach a person and did not.
 */
function CallCard({ payload, text }: { payload: Extract<StructuredMessagePayload, { kind: 'call' }>; text: string | null }) {
  const missed = payload.outcome === 'missed' || payload.outcome === 'failed';
  const Icon = payload.isVideo ? Video : missed ? PhoneMissed : payload.outcome === 'ongoing' ? PhoneIncoming : PhoneOutgoing;

  return (
    <div
      className={`mt-1 rounded-lg border p-2.5 ${
        missed ? 'border-error/40 bg-error/10' : 'border-border-subtle bg-surface-2'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} className={`shrink-0 ${missed ? 'text-error' : 'text-accent'}`} aria-hidden />
        <p className={`text-caption font-medium ${missed ? 'text-error' : 'text-fg'}`}>
          {/* Only reached when the server stored no wording at all - the
              payload alone cannot say which way the call went, so it says
              only what it does know rather than guessing. */}
          {text ?? (payload.isVoiceChat ? 'Voice chat' : payload.isVideo ? 'Video call' : 'Voice call')}
        </p>
      </div>
    </div>
  );
}

export function StructuredMessageCard({ payload, text = null }: { payload: StructuredMessagePayload; text?: string | null }) {
  if (payload.kind === 'location') return <LocationCard payload={payload} />;
  if (payload.kind === 'contacts') return <ContactsCard payload={payload} />;
  if (payload.kind === 'poll') return <PollCard payload={payload} />;
  if (payload.kind === 'call') return <CallCard payload={payload} text={text} />;
  return null;
}

