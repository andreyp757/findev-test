/**
 * Назначение файла: Экран настроек с проверяемым черновиком Reactive Form.
 * Поля не управляют работающим производителем напрямую: только Apply начинает новый запуск.
 */
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from "@angular/forms";
import { RouterLink } from "@angular/router";
import { MarketEngine } from "../market/market-engine";
import { LIMITS, ProducerSettings } from "../market/producer-settings";
import { integer } from "../market/market-format";

const integerValidator = (control: AbstractControl) =>
  Number.isInteger(control.value) ? null : { integer: true };

function control(value: number, min: number, max: number): FormControl<number> {
  return new FormControl(value, {
    nonNullable: true,
    validators: [
      Validators.required,
      Validators.min(min),
      Validators.max(max),
      integerValidator,
    ],
  });
}

@Component({
  selector: "app-settings",
  imports: [ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./settings.html",
  styleUrl: "./settings.css",
})
export class Settings {
  readonly integer = integer;
  readonly engine = inject(MarketEngine);
  readonly fields = [
    {
      key: "instrumentCount" as const,
      label: "Instrument count",
      description: "The number of unique fictional instruments in your market.",
      min: LIMITS.instrumentCount[0],
      max: LIMITS.instrumentCount[1],
      unit: "instruments",
    },
    {
      key: "updatesPerBatch" as const,
      label: "Updates per batch",
      description:
        "The number of trades generated and aggregated in each batch.",
      min: LIMITS.updatesPerBatch[0],
      max: LIMITS.updatesPerBatch[1],
      unit: "updates",
    },
    {
      key: "batchIntervalMs" as const,
      label: "Batch interval",
      description:
        "Time between batches. Lower intervals produce a faster feed.",
      min: LIMITS.batchIntervalMs[0],
      max: LIMITS.batchIntervalMs[1],
      unit: "ms",
    },
  ];
  // Контролы хранят локальный черновик. Рынок увидит его только после успешной валидации Apply.
  readonly form = new FormGroup({
    instrumentCount: control(
      this.engine.settings().instrumentCount,
      ...LIMITS.instrumentCount,
    ),
    updatesPerBatch: control(
      this.engine.settings().updatesPerBatch,
      ...LIMITS.updatesPerBatch,
    ),
    batchIntervalMs: control(
      this.engine.settings().batchIntervalMs,
      ...LIMITS.batchIntervalMs,
    ),
  });
  feedback = "";

  showError(key: keyof ProducerSettings): boolean {
    const c = this.form.controls[key];
    return c.invalid && (c.dirty || c.touched);
  }

  apply(): void {
    this.form.markAllAsTouched();
    this.feedback = "";
    if (this.form.invalid) return;
    if (this.engine.apply(this.form.getRawValue())) {
      this.feedback = `Settings applied. Initializing run ${this.engine.runId()}.`;
      this.form.markAsPristine();
    } else {
      this.feedback = this.engine.error() ?? "Unable to apply settings.";
    }
  }
}
