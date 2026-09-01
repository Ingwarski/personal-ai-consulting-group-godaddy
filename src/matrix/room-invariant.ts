export type RoomBinding = Readonly<{
  roomId: string;
  ownerMxid: string;
  botMxid: string;
  homeserver: "matrix.org";
}>;

export type MatrixRoomState = Readonly<{
  roomId: string;
  encrypted: boolean;
  joinedMembers: readonly string[];
  pendingInvites: number;
  historyVisibility: "joined" | "shared" | "invited" | "world_readable";
  publicAddressOrListing: boolean;
  guestsAllowed: boolean;
  widgetsEnabled: boolean;
  bridgesPresent: boolean;
  botDeviceVerified: boolean;
  botDeviceRevoked: boolean;
}>;

export type RoomInvariantResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        | "wrong_room"
        | "homeserver_mismatch"
        | "room_not_encrypted"
        | "joined_members_mismatch"
        | "pending_invite_present"
        | "history_visibility_not_joined"
        | "public_address_or_listing_present"
        | "guests_allowed"
        | "widget_present"
        | "bridge_present"
        | "bot_device_not_verified"
        | "bot_device_revoked";
    }>;

const matrixOrgMxid = (value: string): boolean => /^@[^:\s]+:matrix\.org$/.test(value);

export function validateRoomInvariant(
  binding: RoomBinding,
  room: MatrixRoomState
): RoomInvariantResult {
  if (binding.homeserver !== "matrix.org" || !matrixOrgMxid(binding.ownerMxid) || !matrixOrgMxid(binding.botMxid)) {
    return { ok: false, code: "homeserver_mismatch" };
  }
  if (room.roomId !== binding.roomId) return { ok: false, code: "wrong_room" };
  if (!room.encrypted) return { ok: false, code: "room_not_encrypted" };

  const expectedMembers = [binding.ownerMxid, binding.botMxid].sort();
  const actualMembers = [...room.joinedMembers].sort();
  if (
    actualMembers.length !== expectedMembers.length ||
    actualMembers.some((member, index) => member !== expectedMembers[index])
  ) {
    return { ok: false, code: "joined_members_mismatch" };
  }
  if (room.pendingInvites !== 0) return { ok: false, code: "pending_invite_present" };
  if (room.historyVisibility !== "joined") return { ok: false, code: "history_visibility_not_joined" };
  if (room.publicAddressOrListing) return { ok: false, code: "public_address_or_listing_present" };
  if (room.guestsAllowed) return { ok: false, code: "guests_allowed" };
  if (room.widgetsEnabled) return { ok: false, code: "widget_present" };
  if (room.bridgesPresent) return { ok: false, code: "bridge_present" };
  if (room.botDeviceRevoked) return { ok: false, code: "bot_device_revoked" };
  if (!room.botDeviceVerified) return { ok: false, code: "bot_device_not_verified" };
  return { ok: true };
}
