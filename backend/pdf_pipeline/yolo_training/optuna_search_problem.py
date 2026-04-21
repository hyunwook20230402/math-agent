"""문제 감지 YOLO11m HP search — Optuna TPE + MedianPruner.

사용법:
  cd backend/pdf_pipeline/yolo_training
  python3 optuna_search_problem.py

완료 후 best HP 로 `train_problem_11m.py` 의 하이퍼파라미터 갱신 → full train.
"""
import logging
import os
from pathlib import Path
import optuna
from optuna.pruners import MedianPruner
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
os.chdir(SCRIPT_DIR)  # yaml 내 ../uploads/... 해석용

STUDY_NAME = "yolo11m_problem_search"
STORAGE = f"sqlite:///{SCRIPT_DIR}/{STUDY_NAME}.db"

TRIAL_EPOCHS = 15
N_TRIALS = 12

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger()


def objective(trial: optuna.Trial) -> float:
    optimizer = trial.suggest_categorical("optimizer", ["SGD", "AdamW"])
    lr0 = trial.suggest_float("lr0", 1e-5, 5e-3, log=True)
    amp = trial.suggest_categorical("amp", [True, False])
    warmup = trial.suggest_int("warmup_epochs", 3, 10)
    wd = trial.suggest_float("weight_decay", 1e-4, 5e-2, log=True)

    run_name = f"optuna_problem_t{trial.number:02d}"
    log.info(f"[trial {trial.number}] optimizer={optimizer} lr0={lr0:.5f} amp={amp} warmup={warmup} wd={wd:.4f}")

    model = YOLO("yolo11m.pt")
    try:
        model.train(
            data="data_new.yaml",
            epochs=TRIAL_EPOCHS,
            imgsz=1280,
            batch=8,
            device=0,
            patience=TRIAL_EPOCHS,
            save=False,
            plots=False,
            verbose=False,
            project=str(SCRIPT_DIR / "runs"),
            name=run_name,
            exist_ok=True,
            optimizer=optimizer,
            lr0=lr0,
            lrf=0.01,
            weight_decay=wd,
            warmup_epochs=warmup,
            warmup_momentum=0.8,
            warmup_bias_lr=0.05,
            cos_lr=True,
            amp=amp,
            hsv_h=0.0, hsv_s=0.0, hsv_v=0.2,
            degrees=0.0, translate=0.05, scale=0.2,
            flipud=0.0, fliplr=0.0, mosaic=0.0, mixup=0.0,
        )
        metrics = model.val(data="data_new.yaml", imgsz=1280, batch=8,
                            verbose=False, plots=False, save=False)
        score = float(metrics.box.map)
        log.info(f"[trial {trial.number}] mAP50-95 = {score:.4f}")
        return score
    except Exception as e:
        log.warning(f"[trial {trial.number}] failed: {e}")
        return 0.0


def main():
    study = optuna.create_study(
        study_name=STUDY_NAME,
        storage=STORAGE,
        direction="maximize",
        sampler=optuna.samplers.TPESampler(seed=42, n_startup_trials=4),
        pruner=MedianPruner(n_startup_trials=4, n_warmup_steps=0),
        load_if_exists=True,
    )
    study.optimize(objective, n_trials=N_TRIALS, gc_after_trial=True)

    print("\n=== BEST TRIAL ===")
    print(f"mAP50-95 = {study.best_value:.4f}")
    for k, v in study.best_params.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
