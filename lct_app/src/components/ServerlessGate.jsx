import { useState } from 'react';
import PropTypes from 'prop-types';

export default function ServerlessGate({ onEnableServerless }) {
  const [apiKey, setApiKey] = useState('');

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
        <p className="mt-2 text-sm leading-relaxed text-gray-600 mb-6">
          The main backend (Tailnet) is down or unreachable. You can continue in 
          Serverless Mode (client-side only) by providing an OpenAI API key.
        </p>
        
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
};
