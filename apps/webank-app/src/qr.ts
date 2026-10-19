import { scanFromURLAsync } from "expo-camera";
import jsQR from "jsqr";
import { Platform } from "react-native";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 2048;

export async function decodeQrImageUri(uri: string): Promise<string> {
  if (Platform.OS !== "web") {
    const codes = await scanFromURLAsync(uri, ["qr"]);
    if (codes.length !== 1 || !codes[0]?.data)
      throw new Error("No single readable QR code was found in this image.");
    return codes[0].data;
  }
  const response = await fetch(uri);
  if (!response.ok) throw new Error("The selected image could not be opened.");
  return decodeQrImageBlob(await response.blob());
}

export async function decodeQrImageBlob(blob: Blob): Promise<string> {
  if (Platform.OS !== "web")
    throw new Error(
      "Image drops are available in the web and mirrored preview.",
    );
  if (!blob.type.startsWith("image/") || blob.size > MAX_IMAGE_BYTES)
    throw new Error("Choose an image smaller than 10 MB.");
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Image decoding is unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(pixels.data, pixels.width, pixels.height, {
      inversionAttempts: "attemptBoth",
    });
    if (!result?.data)
      throw new Error("No readable QR code was found in this image.");
    return result.data;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
