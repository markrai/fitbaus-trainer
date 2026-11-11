import { QueueStrategy, TextToSpeech } from "@capacitor-community/text-to-speech";
export async function speakNative(text) {
    await TextToSpeech.stop();
    await TextToSpeech.speak({
        text,
        rate: 0.92,
        pitch: 1,
        category: "playback",
        queueStrategy: QueueStrategy.Flush,
    });
}
export async function stopNativeSpeech() {
    await TextToSpeech.stop();
}
