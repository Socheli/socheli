import { getMood } from "@os/tokens";

/* Build a MusicGen prompt from the post's MOOD — style descriptors + a target
   BPM drawn from the mood's range. Melodic descriptors push MusicGen toward
   actual music, not noise. */
export function musicPrompt(moodId: string, topic: string): string {
  const mood = getMood(moodId);
  const [lo, hi] = mood.bpm;
  const bpm = Math.round((lo + hi) / 2);
  return `${mood.musicStyle}, around ${bpm} bpm, instrumental, no vocals, looping background score`;
}
