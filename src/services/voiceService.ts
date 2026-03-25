import { getConfig } from '../config'

export class VoiceService {
  async synthesize(text: string): Promise<string | undefined> {
    const config = getConfig()
    if (!config.elevenLabsApiKey) return undefined

    const normalizedText = text.trim()
    if (!normalizedText) return undefined

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenLabsVoiceId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'xi-api-key': config.elevenLabsApiKey,
        },
        body: JSON.stringify({
          text: normalizedText.slice(0, 4500),
          model_id: 'eleven_multilingual_v2',
        }),
      }
    )

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS failed (${response.status})`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    return buffer.toString('base64')
  }
}
