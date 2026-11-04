import type { Characteristic, Service } from "homebridge";
import type { Vehicle } from "../../api/types.js";
import type { FeatureToggles } from "../../config.js";
import type { HomeLocation } from "../../config.js";
import {
  bodyValues,
  isAtHome,
  isPlugConnected,
  isPlugLocked,
  isWindowHeatingOn,
} from "../../vehicle/mapping.js";
import {
  ServiceBinding,
  type BindingContext,
  type ServiceType,
} from "./common.js";

type ContactFeature = Extract<
  keyof FeatureToggles,
  | "doors"
  | "windows"
  | "trunk"
  | "bonnet"
  | "sunroof"
  | "lights"
  | "windowHeating"
  | "plugLock"
>;

interface ContactDefinition {
  feature: ContactFeature;
  displayName: string;
  /** `true` means "contact not detected": open, unlocked for the lock sensors, on otherwise. */
  isOpen: (vehicle: Vehicle) => boolean | undefined;
}

const negate = (value: boolean | undefined) =>
  value === undefined ? undefined : !value;

const CONTACTS: readonly ContactDefinition[] = [
  {
    feature: "doors",
    displayName: "Doors",
    isOpen: (v) => bodyValues(v).doorsOpen,
  },
  {
    feature: "windows",
    displayName: "Windows",
    isOpen: (v) => bodyValues(v).windowsOpen,
  },
  {
    feature: "trunk",
    displayName: "Trunk",
    isOpen: (v) => bodyValues(v).trunkOpen,
  },
  {
    feature: "bonnet",
    displayName: "Bonnet",
    isOpen: (v) => bodyValues(v).bonnetOpen,
  },
  {
    feature: "sunroof",
    displayName: "Sunroof",
    isOpen: (v) => bodyValues(v).sunroofOpen,
  },
  {
    feature: "lights",
    displayName: "Lights",
    isOpen: (v) => bodyValues(v).lightsOn,
  },
  // The API has no command for the window heating, so it is a read-only sensor: open = on.
  {
    feature: "windowHeating",
    displayName: "Window Heating",
    isOpen: isWindowHeatingOn,
  },
  // Without a cable the plug is reported unlocked; only an unlocked cable that is plugged in is open.
  {
    feature: "plugLock",
    displayName: "Plug Locked",
    isOpen: (v) =>
      isPlugConnected(v) === false ? false : negate(isPlugLocked(v)),
  },
];

export class ContactBinding extends ServiceBinding {
  readonly feature: ContactFeature;
  protected readonly serviceType: ServiceType =
    this.ctx.hap.Service.ContactSensor;
  protected readonly subtype: string;
  protected readonly displayName: string;

  constructor(
    ctx: BindingContext,
    private readonly definition: ContactDefinition,
  ) {
    super(ctx);
    this.feature = definition.feature;
    this.subtype = definition.feature;
    this.displayName = definition.displayName;
  }

  protected override get hasStatusFault(): boolean {
    return true;
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    const { ContactSensorState } = this.ctx.hap.Characteristic;
    const open = this.definition.isOpen(vehicle);
    if (open !== undefined) {
      this.set(
        ContactSensorState,
        open
          ? ContactSensorState.CONTACT_NOT_DETECTED
          : ContactSensorState.CONTACT_DETECTED,
      );
    }
  }
}

/** The contact sensors, with the lock after the sunroof so the support log keeps its order. */
export function contactBindings(ctx: BindingContext): ServiceBinding[] {
  const bindings: ServiceBinding[] = CONTACTS.map(
    (definition) => new ContactBinding(ctx, definition),
  );
  const afterSunroof =
    CONTACTS.findIndex((definition) => definition.feature === "sunroof") + 1;
  bindings.splice(afterSunroof, 0, new LockBinding(ctx));
  return bindings;
}

type Perms = NonNullable<Parameters<Characteristic["setProps"]>[0]["perms"]>;
/** `Perms.PAIRED_READ` and `Perms.NOTIFY`, without `PAIRED_WRITE`; the enum is const and type-only here. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- ambient const enum cannot be referenced
const READ_AND_NOTIFY = ["pr", "ev"] as Perms;

/**
 * Lock "Locked": shows "locked" or "unlocked" with a lock icon. The API cannot lock or unlock, so
 * the target state is read-only and HomeKit answers writes with "read-only characteristic". It
 * replaces the "Locked" contact sensor of 0.3.x (subtype "lock"), see `removeLegacyLockSensor`.
 */
export class LockBinding extends ServiceBinding {
  readonly feature = "lock";
  protected readonly serviceType: ServiceType =
    this.ctx.hap.Service.LockMechanism;
  protected readonly subtype = "lock";
  protected readonly displayName = "Locked";

  protected override configure(service: Service): void {
    service
      .getCharacteristic(this.ctx.hap.Characteristic.LockTargetState)
      .setProps({ perms: READ_AND_NOTIFY });
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    const { LockCurrentState, LockTargetState } = this.ctx.hap.Characteristic;
    const locked = bodyValues(vehicle).locked;
    if (locked === undefined) {
      return;
    }
    this.set(
      LockCurrentState,
      locked ? LockCurrentState.SECURED : LockCurrentState.UNSECURED,
    );
    this.set(
      LockTargetState,
      locked ? LockTargetState.SECURED : LockTargetState.UNSECURED,
    );
  }
}

/** Removes the "Locked" contact sensor of 0.3.x, which `LockBinding` replaces. Returns whether it existed. */
export function removeLegacyLockSensor(ctx: BindingContext): boolean {
  const legacy = ctx.accessory.getServiceById(
    ctx.hap.Service.ContactSensor,
    "lock",
  );
  if (!legacy) {
    return false;
  }
  ctx.accessory.removeService(legacy);
  ctx.log.info('Replaced the "Locked" contact sensor with a lock');
  return true;
}

/** Occupancy sensor "Plugged In": detected while the charging cable is plugged in, for automations. */
export class PluggedInBinding extends ServiceBinding {
  readonly feature = "pluggedIn";
  protected readonly serviceType: ServiceType =
    this.ctx.hap.Service.OccupancySensor;
  protected readonly subtype = "plugged-in";
  protected readonly displayName = "Plugged In";

  protected override get hasStatusFault(): boolean {
    return true;
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    const { OccupancyDetected } = this.ctx.hap.Characteristic;
    const pluggedIn = isPlugConnected(vehicle);
    if (pluggedIn !== undefined) {
      this.set(
        OccupancyDetected,
        pluggedIn
          ? OccupancyDetected.OCCUPANCY_DETECTED
          : OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      );
    }
  }
}

/** Occupancy sensor "Home": parked within the configured radius around the home coordinates. */
export class PresenceBinding extends ServiceBinding {
  readonly feature = "presence";
  protected readonly serviceType: ServiceType =
    this.ctx.hap.Service.OccupancySensor;
  protected readonly subtype = "home";
  protected readonly displayName = "Home";

  protected override get hasStatusFault(): boolean {
    return true;
  }

  protected render(_service: Service, vehicle: Vehicle): void {
    const home: HomeLocation | undefined = this.ctx.settings.home;
    if (!home) {
      return;
    }
    const { OccupancyDetected } = this.ctx.hap.Characteristic;
    const atHome = isAtHome(vehicle, home);
    if (atHome !== undefined) {
      this.set(
        OccupancyDetected,
        atHome
          ? OccupancyDetected.OCCUPANCY_DETECTED
          : OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      );
    }
  }
}
