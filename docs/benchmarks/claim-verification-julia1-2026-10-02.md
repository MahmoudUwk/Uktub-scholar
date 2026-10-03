# Claim verification benchmark — Julia-1 vs 135 ground-truthed claims

Date: 2026-10-02 · Corpus: 14 real papers (`test_papers/RF` + `test_papers/smarthome`, ~85k words) · 
Claims: 135 authored by an independent subagent (74 TRUE / 61 FALSE), evidence-verified verbatim against the papers, reworded (not copied) · 
Chunk: full paper text (24k chars) · Engine: Julia-1 144M encoder, 6 resident CPU processes · Wall: 272s · Bar: `VERIFY_MIN_CONFIDENCE=0.99`

## Headline result

| Metric | Value |
|---|---|
| Discrimination (AUC) | **0.529 — coin flip** |
| Mean P(true), TRUE claims | 0.505 |
| Mean P(true), FALSE claims | 0.487 |
| Verdicts at 0.99 bar | 3 decided (all correct refutations) · 132 unverified |
| Best decided-accuracy at any bar | 1.00 @0.99 (n=3) — decides almost nothing |
| Decided accuracy 0.50–0.95 | 0.42–0.54 (coin flip or worse) |
| Dangerous errors (wrong decided verdict) @0.50–0.95 | 4–62 |
| Latency | ~25–95 ms/verdict warm (6 parallel CPU processes) |

**Verdict: Julia-1 carries no truth signal on real research claims (AUC 0.529). Rejected as verdict engine AND as triage filter. The 0.99 bar protects only by abstaining on everything.**

## Threshold sweep

| Bar | Decided | TP | FP | TN | FN | Unverified | Dangerous | Decided acc |
|---|---|---|---|---|---|---|---|---|
| 0.50 | 135 | 41 | 29 | 32 | 33 | 0 | 62 | 0.54 |
| 0.60 | 96 | 26 | 20 | 23 | 27 | 39 | 47 | 0.51 |
| 0.70 | 65 | 18 | 13 | 15 | 19 | 70 | 32 | 0.51 |
| 0.80 | 41 | 13 | 7 | 7 | 14 | 94 | 21 | 0.49 |
| 0.85 | 33 | 8 | 5 | 6 | 14 | 102 | 19 | 0.42 |
| 0.90 | 25 | 7 | 5 | 4 | 9 | 110 | 14 | 0.44 |
| 0.95 | 14 | 6 | 3 | 4 | 1 | 121 | 4 | 0.71 |
| 0.99 | 3 | 0 | 0 | 3 | 0 | 132 | 0 | 1.00 |

## Per-claim results (verdict at 0.99 bar)

| id | paper | kind | ground truth | P(true) | verdict | claim |
|---|---|---|---|---|---|---|
| c001 | 2411.09996v1 | dataset | TRUE | 0.579 | unverified | The HSD dataset provides CSI measurements for six distinct human activities, including run |
| c002 | 2411.09996v1 | numeric | FALSE | 0.482 | unverified | CSI in the HSD dataset is measured over 5,000 subcarriers for each activity. |
| c003 | 2411.09996v1 | method | TRUE | 0.146 | unverified | Masked Spectrogram Modeling pretraining uses high masking ratios of roughly 80 percent to  |
| c004 | 2411.09996v1 | method | FALSE | 0.315 | unverified | For the human activity sensing task, the entire ViT encoder is unfrozen and finetuned toge |
| c005 | 2411.09996v1 | finding | TRUE | 0.687 | unverified | On the segmentation dataset, the best model is a pretrained ViT-M with a 70 percent maskin |
| c006 | 2411.09996v1 | numeric | FALSE | 0.952 | unverified | The RRD dataset consists of 2,400 over-the-air recordings collected in downtown Toronto. |
| c007 | 2411.09996v1 | dataset | TRUE | 0.811 | unverified | In the segmentation dataset label images, NR signals are marked as 1, LTE signals as 2, an |
| c008 | 2411.09996v1 | finding | FALSE | 0.752 | unverified | The pretrained ViT model is outperformed by a four-times larger model trained from scratch |
| c009 | 2411.09996v1 | finding | TRUE | 0.368 | unverified | The ideal masking ratio for pretraining lies between roughly 70 and 80 percent. |
| c010 | 2411.09996v1 | numeric | FALSE | 0.529 | unverified | HSD recordings are kept at their original 3 x 114 x 2000 shape when fed to the model. |
| c011 | 2504.14100v1 | numeric | TRUE | 0.684 | unverified | The best LoRA configuration for RF signal classification uses alpha = 8 and rank = 50, add |
| c012 | 2504.14100v1 | finding | FALSE | 0.674 | unverified | WavesFM roughly doubles the 5G NR positioning error compared to the supervised baseline. |
| c013 | 2504.14100v1 | dataset | TRUE | 0.023 | unverified | The 5G CSI pre-training dataset was gathered with the user terminal at 476 distinct locati |
| c014 | 2504.14100v1 | numeric | FALSE | 0.547 | unverified | The WiFi CSI pre-training dataset contains a total of 8,400 samples. |
| c015 | 2504.14100v1 | method | TRUE | 0.365 | unverified | During evaluation, the last two of the twelve ViT blocks are unfrozen for the positioning, |
| c016 | 2504.14100v1 | finding | TRUE | 0.833 | unverified | The least-squares estimator surpasses both learned models for SNRs above 13 dB. |
| c017 | 2504.14100v1 | numeric | FALSE | 0.505 | unverified | In the simulated MIMO-OFDM system, the base station is equipped with 64 antennas. |
| c018 | 2504.14100v1 | dataset | FALSE | 0.354 | unverified | The RF signal classification dataset spans 45 different signal type classes. |
| c019 | 2504.14100v1 | numeric | FALSE | 0.617 | unverified | The RF-S pre-training dataset contains more than 5,000 spectrogram samples. |
| c020 | 2504.14100v1 | finding | TRUE | 0.558 | unverified | ViT-WiFi, whose pre-training data closely matches the human activity task, converges in ab |
| c021 | 2506.06718v2 | method | TRUE | 0.602 | unverified | The IQFM encoder uses a ShuffleNetV2 (0.5x) backbone with roughly 341k trainable parameter |
| c022 | 2506.06718v2 | dataset | TRUE | 0.975 | unverified | The over-the-air testbed dataset contains 1,115,378 labeled samples split 70/30 into train |
| c023 | 2506.06718v2 | numeric | FALSE | 0.453 | unverified | The mechanical rotation of the transmitter produced 500 distinct AoA classes. |
| c024 | 2506.06718v2 | finding | TRUE | 0.645 | unverified | With a single labeled sample per class, task-specific SSL reaches 99.67 percent modulation |
| c025 | 2506.06718v2 | finding | FALSE | 0.278 | unverified | Channel masking augmentation improves modulation classification accuracy. |
| c026 | 2506.06718v2 | numeric | FALSE | 0.236 | unverified | The LoRA adaptation used for out-of-distribution tasks adds roughly 840,000 trainable para |
| c027 | 2506.06718v2 | dataset | FALSE | 0.567 | unverified | RML2016.10a covers 24 digital and analog modulation schemes. |
| c028 | 2506.06718v2 | finding | TRUE | 0.438 | unverified | KNN-based pseudo-labeling on the modulation-specific encoder attains 99.99 percent accurac |
| c029 | 2506.06718v2 | finding | TRUE | 0.984 | unverified | In the ablation study, removing both cyclic time shifting and channel masking collapses Ao |
| c030 | 2506.06718v2 | finding | FALSE | 0.930 | unverified | The joint-task model beats the task-specific SSL model on AoA classification in the one-sh |
| c031 | 2509.03077v1 | dataset | TRUE | 0.863 | unverified | The captured dataset comprises 68 GB across 4,609 recording files. |
| c032 | 2509.03077v1 | dataset | FALSE | 0.376 | unverified | The development set of the dataset contains 922 files. |
| c033 | 2509.03077v1 | method | TRUE | 0.380 | unverified | The two selected augmentations are antenna dropout and zero masking, each applied with pro |
| c034 | 2509.03077v1 | finding | TRUE | 0.118 | unverified | Doubling the number of linear classifier layers improves frozen-encoder AoA error by 46 pe |
| c035 | 2509.03077v1 | finding | FALSE | 0.008 | refuted | With frozen encoder weights the proposed method attains an AoA MAE of 8.93 degrees, worse  |
| c036 | 2509.03077v1 | dataset | TRUE | 0.100 | unverified | The dataset covers modulation schemes including 16-QAM, 64-QAM, BPSK, QPSK, PAM4, and cont |
| c037 | 2509.03077v1 | method | FALSE | 0.768 | unverified | Antenna dropout was borrowed into this work from prior augmentation techniques for image c |
| c038 | 2509.03077v1 | numeric | FALSE | 0.244 | unverified | Self-supervised pretraining ran for 200 epochs on the MoCo framework. |
| c039 | 2509.03077v1 | finding | TRUE | 0.561 | unverified | In low-label regimes the SSL approach improves over fully supervised baselines by up to ab |
| c040 | 2511.15162v1 | method | TRUE | 0.106 | unverified | The paper builds the first multimodal wireless foundation model that processes both raw IQ |
| c041 | 2511.15162v1 | dataset | TRUE | 0.590 | unverified | The spectrogram pretraining dataset contains a total of 3,200 samples. |
| c042 | 2511.15162v1 | numeric | FALSE | 0.482 | unverified | Pretraining applies a fixed 90 percent masking ratio to both modalities. |
| c043 | 2511.15162v1 | numeric | FALSE | 0.688 | unverified | The multimodal WFM has roughly 70 million parameters. |
| c044 | 2511.15162v1 | finding | FALSE | 0.939 | unverified | On RF signal classification the multimodal WFM outperforms WavesFM under linear probing. |
| c045 | 2511.15162v1 | method | TRUE | 0.072 | unverified | LoRA fine-tuning uses rank 32 and scaling 32, totaling about 0.3M task-specific parameters |
| c046 | 2511.15162v1 | finding | TRUE | 0.411 | unverified | Compared to partial fine-tuning of two blocks, LoRA improves performance on four of six ta |
| c047 | 2511.15162v1 | finding | FALSE | 0.244 | unverified | On RF fingerprinting, IQFM outperforms the multimodal WFM under linear probing. |
| c048 | 2511.15162v1 | dataset | FALSE | 0.313 | unverified | The 5G NR positioning task takes raw IQ traces as input to predict the UE location. |
| c049 | 2606.06373v1 | method | TRUE | 0.565 | unverified | In LatentWave's JEPA pretraining, the target encoder's parameters are updated as an expone |
| c050 | 2606.06373v1 | numeric | TRUE | 0.564 | unverified | The context and target encoders are ViTs with 8 layers, 8 attention heads, embedding dimen |
| c051 | 2606.06373v1 | finding | FALSE | 0.746 | unverified | Frequency masking preserves discriminability for signal classification better than region  |
| c052 | 2606.06373v1 | finding | TRUE | 0.963 | unverified | Switching from region to frequency masking improves beam prediction by more than 11 percen |
| c053 | 2606.06373v1 | numeric | FALSE | 0.540 | unverified | Under frequency masking, RF signal classification accuracy rises from 80.9 percent to 86.1 |
| c054 | 2606.06373v1 | method | TRUE | 0.594 | unverified | Stochastic channel sampling draws the retained channel count uniformly from 1 up to the av |
| c055 | 2606.06373v1 | dataset | FALSE | 0.323 | unverified | The pretraining corpus includes a WiFi CSI dataset with 484 three-channel samples. |
| c056 | 2606.06373v1 | finding | FALSE | 0.703 | unverified | LatentWave is evaluated on six downstream tasks, including modulation classification and i |
| c057 | 2606.06373v1 | method | TRUE | 0.606 | unverified | After pretraining, the target encoder is the component extracted for downstream use. |
| c058 | 2606.06373v1 | numeric | FALSE | 0.008 | refuted | LatentWave pretraining runs for 800 epochs with a batch size of 256. |
| c059 | 2609.04707v1 | finding | TRUE | 0.092 | unverified | The survey organizes the WFM literature into five physical-layer task families, including  |
| c060 | 2609.04707v1 | finding | TRUE | 0.664 | unverified | RF sensing and localization is the most frequently covered major category, appearing in 30 |
| c061 | 2609.04707v1 | finding | FALSE | 0.256 | unverified | Spectrum sensing and monitoring is the most commonly covered task category among the surve |
| c062 | 2609.04707v1 | finding | TRUE | 0.209 | unverified | The number of identified WFM papers grew from 6 in 2024 to 23 in 2025, an increase of roug |
| c063 | 2609.04707v1 | finding | TRUE | 0.783 | unverified | Among channel representation WFMs, masked reconstruction is the dominant pretraining objec |
| c064 | 2609.04707v1 | finding | FALSE | 0.165 | unverified | The survey includes papers on generic LLM-based wireless applications regardless of physic |
| c065 | 2609.04707v1 | method | TRUE | 0.576 | unverified | LatentWave is a JEPA-based model that tests latent prediction against direct masked recons |
| c066 | 2609.04707v1 | dataset | FALSE | 0.137 | unverified | The literature search covered papers published from 2020 until June 2026. |
| c067 | 2609.04707v1 | method | TRUE | 0.906 | unverified | WiMamba uses a Mamba-based state-space model as its main CSI encoder. |
| c128 | Papaers_overview | finding | TRUE | 0.749 | unverified | IQ-based foundational models reached 99.67 percent modulation classification accuracy with |
| c129 | Papaers_overview | method | TRUE | 0.839 | unverified | Lightweight backbones such as ShuffleNetV2 (0.5x) are preferred for edge deployment of the |
| c130 | Papaers_overview | numeric | FALSE | 0.268 | unverified | The LoRA adaptation described introduces about 84 million trainable parameters. |
| c131 | Papaers_overview | finding | TRUE | 0.149 | unverified | In one-shot scenarios, the models outperform supervised counterparts by up to 145x on AoA  |
| c132 | Papaers_overview | numeric | FALSE | 0.551 | unverified | For out-of-distribution beam prediction, the adapted model achieved 89.15 percent accuracy |
| c133 | Papaers_overview | numeric | TRUE | 0.982 | unverified | With 10 labeled samples per class, the joint SSL model achieved 95.71 percent modulation a |
| c134 | Papaers_overview | finding | FALSE | 0.971 | unverified | Time rolling (cyclic time shifting) alters the magnitude spectrum of the signal, which har |
| c135 | Papaers_overview | numeric | FALSE | 0.648 | unverified | Using only 0.1 percent of labeled data (about 1,784 samples), SSL improved AoA MAE by 51.9 |
| c068 | Tiny_Federated_Wireless_Foun | numeric | TRUE | 0.125 | unverified | The pruned ViT-based WFMs achieve up to 93 percent MACs reduction and 85 percent lower CPU |
| c069 | Tiny_Federated_Wireless_Foun | numeric | FALSE | 0.413 | unverified | The pruning plus frozen-head FL design cuts communication overhead by 90 percent. |
| c070 | Tiny_Federated_Wireless_Foun | method | TRUE | 0.436 | unverified | The base model is a ViT small with 12 encoder blocks and eight attention heads. |
| c071 | Tiny_Federated_Wireless_Foun | numeric | FALSE | 0.562 | unverified | The three generated pruned models use pruning ratios of 55 percent, 78 percent, and 90 per |
| c072 | Tiny_Federated_Wireless_Foun | finding | FALSE | 0.305 | unverified | Pruning encoder block 0 causes only a negligible loss increase of about 0.0005. |
| c073 | Tiny_Federated_Wireless_Foun | method | TRUE | 0.254 | unverified | The pruning implementation relies on the DepGraph framework for dependency-aware pruning. |
| c074 | Tiny_Federated_Wireless_Foun | method | FALSE | 0.464 | unverified | The block-wise pruning procedure requires access to each client's labeled local dataset. |
| c075 | Tiny_Federated_Wireless_Foun | dataset | TRUE | 0.742 | unverified | For the radio signal identification task, the evaluation was restricted to the ten most re |
| c076 | Tiny_Federated_Wireless_Foun | dataset | FALSE | 0.784 | unverified | The federated system uses twenty clients, all of which participate in every round. |
| c077 | Tiny_Federated_Wireless_Foun | numeric | TRUE | 0.567 | unverified | For human activity recognition, pruning shrinks model size from 148.22 MB to 13.24 MB. |
| c078 | http_thesai.org_Downloads_Vo | dataset | TRUE | 0.264 | unverified | The Homergy Box provides sixteen relay channels using four four-channel relay boards. |
| c079 | http_thesai.org_Downloads_Vo | method | FALSE | 0.563 | unverified | The NodeMCU directly drives the appliance-connected relays without a separate microcontrol |
| c080 | http_thesai.org_Downloads_Vo | numeric | TRUE | 0.268 | unverified | Homergy delivered weekly savings of 0.5 kWh for the lifeline consumer and 18 kWh for the n |
| c081 | http_thesai.org_Downloads_Vo | finding | TRUE | 0.087 | unverified | In the high-consuming house, Homergy improved on existing smart-devices-only systems by 13 |
| c082 | http_thesai.org_Downloads_Vo | numeric | FALSE | 0.110 | unverified | Homergy produced weekly energy savings of 5 kWh for the low-consuming house. |
| c083 | http_thesai.org_Downloads_Vo | method | TRUE | 0.560 | unverified | The normally closed relay port is wired between source and load so current still flows whe |
| c084 | http_thesai.org_Downloads_Vo | method | FALSE | 0.526 | unverified | The Homergy mobile application was written as a native Java Android app. |
| c085 | http_thesai.org_Downloads_Vo | method | TRUE | 0.709 | unverified | Each Homergy Box's Access Code is embedded in an encrypted QR code on the device. |
| c086 | http_thesai.org_Downloads_Vo | finding | FALSE | 0.449 | unverified | About 69 percent of households in Africa own at least one smart device. |
| c087 | http_thesai.org_Downloads_Vo | method | TRUE | 0.400 | unverified | I2C serial communication links the Arduino microcontroller with the NodeMCU Wi-Fi module. |
| c088 | https_www.mdpi.com_2071-1050 | finding | TRUE | 0.378 | unverified | Across the studied scenarios the wind-driven optimization algorithm beats differential evo |
| c089 | https_www.mdpi.com_2071-1050 | dataset | TRUE | 0.802 | unverified | The study integrates a 5 kW rooftop solar PV on-grid system. |
| c090 | https_www.mdpi.com_2071-1050 | numeric | FALSE | 0.969 | unverified | Without PV, WDOA achieves a daily PAR of 3.94. |
| c091 | https_www.mdpi.com_2071-1050 | numeric | TRUE | 0.550 | unverified | Off-peak households pay 0.00517 USD per kWh for the first 50 kWh consumed. |
| c092 | https_www.mdpi.com_2071-1050 | numeric | FALSE | 0.251 | unverified | The TOUP scheme assumes peak energy costs are 100 percent greater than off-peak costs. |
| c093 | https_www.mdpi.com_2071-1050 | numeric | TRUE | 0.376 | unverified | The day is divided into 120 time slots, each lasting 12 minutes. |
| c094 | https_www.mdpi.com_2071-1050 | numeric | FALSE | 0.464 | unverified | With variable time planning and PV, WDOA achieves a minimal PAR of 3.46. |
| c095 | https_www.mdpi.com_2071-1050 | numeric | FALSE | 0.771 | unverified | The overall daily energy demand of the devices equals 29.79 kWh. |
| c096 | https_www.mdpi.com_2071-1050 | finding | TRUE | 0.677 | unverified | Constant time-range planning without PV cuts the power price by 15.78 percent relative to  |
| c097 | https_www.mdpi.com_2071-1050 | method | FALSE | 0.820 | unverified | The paper benchmarks WDOA against a genetic algorithm as the comparison optimizer. |
| c098 | https_www.mdpi.com_2079-9292 | method | TRUE | 0.788 | unverified | The smart plug measures RMS current, frequency, power factor, and active and reactive powe |
| c099 | https_www.mdpi.com_2079-9292 | numeric | TRUE | 0.578 | unverified | The decision tree classifier's inference latency measured on the Raspberry Pi was 1.59 mic |
| c100 | https_www.mdpi.com_2079-9292 | finding | TRUE | 0.389 | unverified | The time-of-use based demand-response program can cut the power cost by roughly 30 percent |
| c101 | https_www.mdpi.com_2079-9292 | method | FALSE | 0.438 | unverified | The smart meter was prototyped with Arduino and the smart plug with Raspberry Pi. |
| c102 | https_www.mdpi.com_2079-9292 | finding | TRUE | 0.801 | unverified | The accuracy of the smart meter exceeds 97 percent and that of the smart plug exceeds 99 p |
| c103 | https_www.mdpi.com_2079-9292 | numeric | FALSE | 0.011 | unverified | The Gaussian naive Bayes classifier reached 97 percent accuracy in the algorithm compariso |
| c104 | https_www.mdpi.com_2079-9292 | numeric | TRUE | 0.074 | unverified | In the worked TOU example, the daily energy bill falls from about 9.22 USD without DR to 6 |
| c105 | https_www.mdpi.com_2079-9292 | method | FALSE | 0.632 | unverified | The smart plug communicates with the smart meter over Bluetooth. |
| c106 | https_www.mdpi.com_2079-9292 | method | TRUE | 0.507 | unverified | The proposed grid-frequency estimation algorithm runs in linear time, unlike the FFT-based |
| c107 | https_www.mdpi.com_2079-9292 | dataset | FALSE | 0.347 | unverified | In the Peco TOU tariff, the weekday peak time runs from 6 a.m. to 10 a.m. |
| c108 | https_www.mdpi.com_2079-9292 | method | TRUE | 0.078 | unverified | The proposed HEMS uses WI-SUN HAN between the control unit and smart outlets, and WI-SUN F |
| c109 | https_www.mdpi.com_2079-9292 | method | TRUE | 0.080 | unverified | The middleware database uses SQLite, implemented as a circular buffer with a maximum size. |
| c110 | https_www.mdpi.com_2079-9292 | numeric | FALSE | 0.457 | unverified | The collected data were split 80 percent for training and 20 percent for testing. |
| c111 | https_www.mdpi.com_2079-9292 | dataset | TRUE | 0.978 | unverified | The smart outlets collected measurements every 5 seconds, i.e., at 1/5 Hz. |
| c112 | https_www.mdpi.com_2079-9292 | method | TRUE | 0.974 | unverified | The load disaggregation pipeline applies PCA both to identify loads and to extract feature |
| c113 | https_www.mdpi.com_2079-9292 | dataset | FALSE | 0.695 | unverified | The proof-of-concept outlets monitored a washing machine, an electric oven, and a water he |
| c114 | https_www.mdpi.com_2079-9292 | method | TRUE | 0.582 | unverified | The middleware periodically sends information to the cloud using the MQTT protocol. |
| c115 | https_www.mdpi.com_2079-9292 | finding | TRUE | 0.678 | unverified | In field trials, Wi-SUN HAN proved more robust than WiFi even for outlets behind stainless |
| c116 | https_www.mdpi.com_2079-9292 | method | FALSE | 0.289 | unverified | The middleware was developed in Java due to its portability on embedded systems. |
| c117 | https_www.mdpi.com_2079-9292 | method | TRUE | 0.562 | unverified | The system applies machine learning to estimate individual appliance consumption when only |
| c118 | https_www.mdpi.com_2624-6511 | method | TRUE | 0.100 | unverified | The proposed SHEMS architecture is centred on a Knowledge Base communicated through the NG |
| c119 | https_www.mdpi.com_2624-6511 | numeric | FALSE | 0.681 | unverified | The test-bed's rooftop PV array provides up to 16 kW of electric power. |
| c120 | https_www.mdpi.com_2624-6511 | dataset | FALSE | 0.813 | unverified | The test-bed's 28 kWh battery storage system is fully installed and operational. |
| c121 | https_www.mdpi.com_2624-6511 | method | TRUE | 0.332 | unverified | DABGEO is selected as the main ontology for the information model. |
| c122 | https_www.mdpi.com_2624-6511 | dataset | TRUE | 0.485 | unverified | The existing home automation system runs Home Assistant on a Raspberry Pi 4 with 4 GB of R |
| c123 | https_www.mdpi.com_2624-6511 | method | FALSE | 0.328 | unverified | Access to context information is controlled by role-based access control with server-side  |
| c124 | https_www.mdpi.com_2624-6511 | dataset | TRUE | 0.448 | unverified | The espresso machine connected to the smart plug has a peak power consumption of 1.6 kW. |
| c125 | https_www.mdpi.com_2624-6511 | finding | FALSE | 0.008 | refuted | The pool filtration system is deliberately scheduled outside PV production hours to avoid  |
| c126 | https_www.mdpi.com_2624-6511 | finding | TRUE | 0.421 | unverified | The HEC notifies users when the grid energy import reaches 80 percent. |
| c127 | https_www.mdpi.com_2624-6511 | method | TRUE | 0.210 | unverified | The implementation uses the Orion-LD context broker and the Keyrock identity management co |

## Method

1. Independent subagent authored 135 claims (74 TRUE / 61 FALSE, 8–12 per paper, reworded not copied; FALSE = contradicted or plausible fabrication).
2. Orchestrator verified every evidence quote verbatim against the paper text (135/135 passed, 0 dropped).
3. Claims batched through 6 resident Julia-1 processes (24k-char paper context), verdicts mapped at the 0.99 bar, threshold sweep computed over the full P(true) distribution.

## Addendum: GLiNER2.5-Decide (340M, Apache-2.0) on the same 135 claims

Same dataset, same passages. Input: `Passage: …\n\nClaim: …`, labels
`["supported", "refuted"]` (best of 3 encodings; the encoding that puts the
claim inside the labels mislabels contradictions as support). DeBERTa-v2
encoder, 512-token window.

| Condition | Latency | Accuracy | TP | TN | FP | FN |
|---|---|---|---|---|---|---|
| A: 4000-char window | 2125 ms/claim | 0.541 | 66 | 7 | 54 | 8 |
| B: 1800-char chunk | 801 ms/claim | 0.533 | 68 | 4 | 57 | 6 |

Majority-class baseline ("everything supported") = 74/135 = **0.548** —
GLiNER2.5-Decide sits at or below it: it answers "supported" to 120/135
claims, including 54 of the 61 fabricated ones.

**Conclusion of the two-model sweep: sub-1B decision/classifier encoders
(Julia-1 144M, GLiNER2.5-Decide 340M) cannot verify scientific claims
against real papers — both score coin-flip. The Stage-D verdict engine must
be either (a) an NLI/FEVER-trained model (premise-entailment is its native
task — e.g. DeBERTa-v3 FEVER-class models, ~400 MB, CPU-fast) or (b) a small
generative model via llama.cpp (0.5–1B Q4). Both rerun this benchmark.


## Addendum 2: corrected-usage retests (external best-practice audit, 2026-10-02)

An external best-practices study (HF cards, package sources, commit history,
independent evals) found two real usage concerns; both were retested:

1. **Julia-1 operating point.** Published accuracy (73.15% typed / 80.5%
   noul-with-descriptions) was measured at `max_length=1024, head_length=512`
   on SHORT general-domain states; `inference-policy.json` marks long-context
   accuracy "not established". Our snapshot IS at the criteria-fix revision
   (a85b1273 = our snapshot hash — the "silently discarded criteria" bug does
   NOT apply), and our 24k-char states fit the native 8192 window (strict
   encoding never raised). **Retest at 1024/512 with abstract context:**
   P(true) collapsed to 0.0002–0.0065 for ALL claims — but see Addendum 3:
   that retest also changed the formulation, so treat it as a prompt
   artifact, not an operating-point result. The standing Julia-1 evidence
   is the auditor-validated 24k-char benchmark (AUC 0.529).
2. **GLiNER right-truncation.** Right truncation cut the claim on long
   passages in condition A (struck). **Retests with claim-first + 300-word
   passage (plain and description labels) AND the documented
   schema-builder format with few-shot examples:** "supported" to ALL FOUR
   probes at 0.93–0.996 confidence — the documented positive-label bias
   (62–70/101 independent; ours 120/135) holds in every encoding.
   **Rejection robust across the valid configurations.**

External audit also confirmed the architectural verdict: neither model was
trained for NLI — we evaluated routers on an entailment task. The
purpose-trained tool class for passage-entails-claim is **MiniCheck**
(LLM-AggreFact: MiniCheck-RoBERTa-Large 355M = 72.7 BAcc, MiniCheck-Flan-T5
770M = 74.7, CPU-feasible — github.com/Liyan06/MiniCheck) — now the primary
Stage-D candidate, ahead of 0.5–1B instruct LLMs.


## Addendum 3: audit corrections (2026-10-02, independent reviewer + external study)

- **Condition A struck as invalid.** With 4000-char inputs the 512-token
  window cut the claim out of 135/135 rows (right truncation, no error), so
  condition-A numbers measured nothing. Condition B (1800-char chunk,
  claim inside the window) stands: accuracy 0.533, "supported" to 57/61
  fabricated claims.
- **Documented format tried (the auditor's gap).** gliner2's own
  schema-builder best practice — classification with instruction, label
  descriptions, and few-shot examples, `model.extract(...,
  include_confidence=True)` — on 4 probe pairs: "supported" at confidence
  0.927–0.996 for ENTailed, CONTRADICTED, and UNRELATED alike. The
  positive-label bias is the model, not the encoding.
- **Julia-1 attribution corrected.** The 1024/512 retest changed the
  formulation at the same time (added a "Passage:" prefix), so the
  everything-collapses-to-zero result cannot be attributed to the operating
  point alone. The standing evidence for Julia-1's rejection is the
  auditor-validated 24k-char benchmark itself (AUC 0.529, methodologically
  sound) plus inference-policy's "long-context task accuracy not
  established".
- **Generalized conclusion, precisely stated:** Julia-1 rejected (AUC 0.529
  at scale, auditor-validated method); GLiNER2.5-Decide rejected (three
  surviving configurations: 1800-char B run, claim-first, documented
  schema+few-shot — all majority-baseline or all-supported). The class-level
  statement "sub-1B decision/classifier encoders cannot verify scientific
  claims" is supported for these two models on this dataset and should be
  tested per-model, not assumed, for other members of the class.

## Addendum 4: chunked re-benchmark under the owner's architecture (2026-10-02)

Owner directive implemented and measured: papers chunked to 8192-token
targets (yaml-configured, tokenizer-calibrated chars/token 2.8 -- the densest
paper measures 3.10; strict encoding never raised), every claim verified
against EVERY chunk in parallel (4 workers, 42 chunks over 14 papers, one
resident process per worker), paper verdict = any-chunk-supported, verdicts
cached content-addressed in the registry.

| Metric | Whole-paper (24k chars) | Chunked (8192-token, any-chunk) |
|---|---|---|
| AUC | 0.529 | **0.461** |
| Mean P(true) TRUE / FALSE | 0.505 / 0.487 | 0.666 / **0.697** |
| Verdicts @0.99 | 3 decided (correct) | 1 decided (correct) - 134 unverified |
| Wall | 272 s (6 workers) | 900 s (4 workers, 420 chunk-verifications) |

Fabricated claims still outscore true ones under chunk+query. **Chunking did
not rescue Julia-1 -- the rejection is robust across both input
architectures.** The chunking/pointer/cache infrastructure is kept
(engine-agnostic): MiniCheck or any Stage-D engine plugs into the same
chunk-first pipeline and reruns this benchmark.

## Addendum: usage audit (independent subagent, 2026-10-03)

Hypothesis "we used Julia-1 wrong" was tested surgically on 10 failing
cases (chunks only) against the card and the installed package source.

**Two real usage deviations found (our side):**
1. Prompt wording: our 40-word multi-clause instructions sit outside the
   training/eval distribution — noul instructions there are 5-11-word
   declarative propositions. Using the claim itself as the proposition
   raises direction-correct cases from 1/10 to 6/10 at the 0.5 threshold.
2. State length: training states are 83-528-token JSON records (median
   255) and the published benchmark pins max_length=1024; our ~5k-token
   prose chunks are permitted (8,192 strict limit) but unevaluated
   territory per the card.

**Confirmed correct:** criteria on noul is per-spec and HELPS (483/600
with descriptive criteria vs 391/600 literal — CPU FP32 re-run; the
80.67% card figure is the CUDA BF16 run). Nothing was truncated (strict
encoding would raise; head budget 256 ≥ our ~109-token prompt).

**Root cause that remains (model limitation):** even with 20-60-token
evidence sentences as state — fully in-distribution length — verbatim
restatements score 0.82-1.0 but numeric contradictions are missed
(5,000 vs 114 subcarriers; 2,400 vs 240 recordings; 3x114x2000 vs
3x224x224; pTrue 0.57-0.99 for false claims). A 144M encoder cannot
compare numbers. **The rejection stands regardless of usage: Julia-1 is
unsuited to numeric scientific claim verification.** (Also noted: 5 of 10
recorded scores showed reproducibility drift under benign runtime
variation — borderline outputs are unstable.)

## Addendum: bev-decider-0.4B and Lumma-fev-0.6b (2026-10-03)

Two further open local engines, same 135-claim harness. bev ran on its own
/v1/systemone server (GPU) at its documented 2,048-token state limit — a
2048-token chunk arm (config/chunking-2048.yaml, 144 chunks); whole-paper
skipped (would truncate). Lumma-fev-0.6b served the standard whole and 8k
chunked arms.

| Engine (mode) | AUC | P(true) T / F | @0.99 | Sweep | Wall |
|---|---|---|---|---|---|
| bev-decider-0.4B (2048-chunked) | 0.671 | .866 / .809 | 3 decided, 3/3, 0 FP | @0.95: 17 decided, 2 dangerous | 298 s |
| Lumma-fev-0.6b (whole) | 0.449 | — | 0 decided | below chance | 149 s |
| Lumma-fev-0.6b (8k chunked) | 0.456 | .438 / .446 | 0 decided | inverted | 330 s |

**bev-decider:** below K2's chunked AUC (0.671 vs 0.814) but keeps the
zero-false-positive discipline at 0.99 and — unlike K2/Julia/Laya —
correctly rejects the numeric fabrication pair (P 0.338 on "2,400 vs 240
recordings"). Never refutes (tn=0). Same 0.99-knee shape as K2.
CC-BY-NC-4.0: benchmark-only, flagged for any product use.

**Lumma-fev-0.6b:** REJECTED — AUC below chance in both modes with the
card's own calibration warning confirmed on our distribution. (Its 4B
sibling, claimed 0.78 typed-decisions, remains untested.)
