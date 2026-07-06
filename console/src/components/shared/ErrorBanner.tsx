import { X } from 'lucide-react';

/** Small dismissible inline error banner for surfacing data-loading failures. */
export default function ErrorBanner({ message, onDismiss }: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-2.5 text-sm mb-4">
      <span className="min-w-0 break-words">{message}</span>
      <button
        onClick={onDismiss}
        className="flex-shrink-0 mt-0.5 text-red-400/70 hover:text-red-300 transition-colors"
        title="Dismiss"
        aria-label="Dismiss error"
      >
        <X size={14} />
      </button>
    </div>
  );
}
