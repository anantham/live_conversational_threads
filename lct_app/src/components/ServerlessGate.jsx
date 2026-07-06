import { useState } from 'react';
import PropTypes from 'prop-types';
import { trialAvailable } from '../services/serverless/serverlessAuth';

export default function ServerlessGate({ onEnableServerless, onStartTrial }) {
  const [apiKey, setApiKey] = useState('');
  const canTrial = Boolean(onStartTrial) && trialAvailable();

  const handleSubmit = (e) => {
    e.preventDefault();
    if (apiKey.trim()) {
      onEnableServerless(apiKey.trim());
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
      <div className="w-full max-w-md text-center bg-white p-8 rounded shadow-sm border border-gray-200">
        <h1 className="text-xl font-semibold text-gray-800">
          Live Conversational Threads
        </h1>
        <div className="mt-2 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide bg-blue-100 text-blue-800">
          Serverless Mode
        </div>
        <p className="mt-5 text-sm font-medium text-gray-800">
          Backend is unreachable
        </p>
        <p className="mt-2 text-sm leading-relaxed text-gray-600 mb-5">
          You can run it right here in your browser (nothing goes to our servers).
          {canTrial
            ? ' Take it for a 5 minute spin on us, then continue with your own OpenAI key.'
            : ' Add your OpenAI key to continue.'}
        </p>

        {canTrial ? (
          <button
            type="button"
            onClick={onStartTrial}
            className="w-full rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
          >
            Try it free for 5 minutes
          </button>
        ) : null}

        {canTrial ? (
          <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wide text-gray-400">
            <span className="h-px flex-1 bg-gray-200" />
            or use your own key
            <span className="h-px flex-1 bg-gray-200" />
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            placeholder="sk-proj-..."
            className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            type="submit"
            disabled={!apiKey.trim()}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            Start Serverless Session
          </button>
        </form>
      </div>
    </div>
  );
}

ServerlessGate.propTypes = {
  onEnableServerless: PropTypes.func.isRequired,
  onStartTrial: PropTypes.func,
};
