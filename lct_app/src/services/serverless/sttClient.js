import { upload } from '@vercel/blob/client';

/**
 * Uploads an audio blob/file to Vercel Blob and triggers OpenAI transcription.
 * @param {string} apiKey - The BYOK OpenAI key
 * @param {File|Blob} fileOrBlob - The audio file
 * @returns {Promise<Object>} Diarized transcript object
 */
export async function transcribeAudio(apiKey, fileOrBlob) {
  // 1. Upload to Vercel Blob using the client-side proxy to mint tokens
  const uploadResult = await upload(fileOrBlob.name || 'audio.webm', fileOrBlob, {
    access: 'public',
    handleUploadUrl: '/api/proxy/upload',
    clientPayload: JSON.stringify({}), 
    requestInit: {
      headers: {
        'x-lct-byok-key': apiKey
      }
    }
  });

  // 2. Call our transcribe proxy which pipes the blob URL to OpenAI
  const res = await fetch('/api/proxy/transcribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-lct-byok-key': apiKey
    },
    body: JSON.stringify({
      blobUrl: uploadResult.url,
      language: 'en',
      model: 'gpt-4o-transcribe-diarize', // The advanced diarization model as spec'd in ADR-060
      response_format: 'verbose_json',
      timestamp_granularities: ['segment', 'word']
    })
  });
  
  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Transcription failed (${res.status}): ${errorText}`);
  }
  
  const rawResponse = await res.json();

  // 3. Normalize the OpenAI response to our internal diarized shape
  // OpenAI verbose_json usually has { segments: [{ start, end, text, words: [...] }] }
  // Our model 'gpt-4o-transcribe-diarize' natively injects 'speaker' into segments.
  const segments = (rawResponse.segments || []).map(seg => ({
    speaker: seg.speaker || 'SPEAKER_00', // Fallback if model doesn't inject it
    start: seg.start,
    end: seg.end,
    text: seg.text?.trim() || '',
    words: (seg.words || []).map(w => ({
      word: w.word?.trim(),
      start: w.start,
      end: w.end,
      speaker: w.speaker || seg.speaker || 'SPEAKER_00' // Word-level speaker if available
    }))
  }));

  return {
    segments,
    text: rawResponse.text || segments.map(s => s.text).join(' '),
    language: rawResponse.language || 'en',
    duration: rawResponse.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0)
  };
}
