import { api, type ConfigStatus } from "@/state/store";
import { botAvatarUrlSchema } from "../../shared/bot-avatar";

type Request = (path: string, init?: RequestInit) => Promise<any>;

/** Config merges profile members; never resend another field's stale draft. */
export function saveProfileField(field: "name" | "email", value: string, request: Request = api): Promise<ConfigStatus> {
  const trimmed = value.trim();
  return request("/api/config", { method: "PUT", body: JSON.stringify({ profile: { [field]: field === "email" ? trimmed.toLowerCase() : trimmed } }) });
}

/** Replace this server owner's photo. Only an explicit profile action calls
 * this; `expected` names the photo being replaced, so the server can refuse
 * a stale or automatic write from a device that is not the owner's. */
export async function saveProfilePhoto(photo: string | null, request: Request = api): Promise<string> {
  const config = await request("/api/config") as { profile?: { avatarUrl?: string } } | undefined;
  const expected = config?.profile?.avatarUrl ?? "";
  const result = await request("/api/multiplayer/profile-photo", { method: "PUT", body: JSON.stringify({ photo, expected }) });
  if (result.avatarUrl !== "" && !botAvatarUrlSchema.safeParse(result.avatarUrl).success) throw new Error("The saved profile photo could not be used");
  return result.avatarUrl;
}

/** Match the mobile owner's JPEG contract: bounded raster image, portable attachment. */
export async function prepareProfilePhoto(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
  if (file.size > 10 * 1024 * 1024) throw new Error("Choose a photo smaller than 10 MB");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("This image could not be decoded. Choose another photo."));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("This image could not be decoded");
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This image could not be resized");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.85);
    const photo = data.replace(/^data:image\/jpeg;base64,/, "");
    if (photo === data || !photo || Math.ceil(photo.length * 3 / 4) > 256_000) throw new Error("This photo could not be reduced below 256 KB. Choose a smaller photo.");
    return photo;
  } finally {
    URL.revokeObjectURL(url);
  }
}
