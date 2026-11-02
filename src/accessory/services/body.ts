import type { Service } from "homebridge";
import type { Vehicle } from "../../api/types.js";
import type { FeatureToggles } from "../../config.js";
import type { HomeLocation } from "../../config.js";
import {
  bodyValues,
  isAtHome,
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
  | "lock"
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
  // The API cannot lock or unlock, so the lock state is a read-only sensor: closed = locked.
  {
    feature: "lock",
    displayName: "Locked",
    isOpen: (v) => negate(bodyValues(v).locked),
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
  {
    feature: "plugLock",
    displayName: "Plug Locked",
    isOpen: (v) => negate(isPlugLocked(v)),
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

export function contactBindings(ctx: BindingContext): ContactBinding[] {
  return CONTACTS.map((definition) => new ContactBinding(ctx, definition));
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
