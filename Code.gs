/****************************************************************************************
 * WAT KOH FAMILY & COMMUNITY HEALTH SYSTEM
 * Backend API: Google Apps Script (V8)
 * Version: 1.0.0
 *
 * ARCHITECTURE
 * - This Google Apps Script project contains Code.gs only; Google Sheets is the database.
 * - index.html and dashboard.html remain hosted separately on GitHub Pages.
 * - Cloudflare Worker is a transparent CORS/proxy layer between GitHub Pages and this API.
 * - Set GAS_WEB_APP_URL in Cloudflare Worker to this deployed /exec URL.
 * - Put the Cloudflare Worker URL in API_URL in both frontend HTML files.
 * - Public system information continues to use GET/JSONP through the Worker.
 * - ALL authenticated requests (including reads) continue to use POST through a hidden
 *   form + iframe. Session tokens stay inside the POST body, never in the URL.
 * - The POST endpoint continues to return postMessage HTML. The Worker passes this HTML
 *   through unchanged so the existing frontend nonce and iframe-source checks still work.
 * - Worker handles OPTIONS/CORS headers and forwards only the existing API routes; the
 *   authorization, sessions, validation, and business logic remain in this Code.gs.
 *
 * INITIAL SETUP
 * 1. Create a standalone Apps Script project and paste this entire file into Code.gs.
 * 2. Run initializeSystem() once from the Apps Script editor and authorize access.
 *    The function creates the Google Spreadsheet if no SPREADSHEET_ID is configured,
 *    then creates every required sheet and its complete header row automatically.
 * 3. Run createInitialAdmin("username", "a-strong-password", "Administrator") once.
 * 4. In Project Settings > Script properties, set IMGBB_API_KEY.
 * 5. Deploy > New deployment > Web app; Execute as: Me; access: Anyone.
 * 6. Put the /exec URL in Cloudflare Worker variable GAS_WEB_APP_URL.
 * 7. Set ALLOWED_ORIGINS in Worker to the exact GitHub Pages origin (for example,
 *    https://YOUR-ACCOUNT.github.io). Set API_URL in both HTML files to the Worker URL.
 *
 * IMPORTANT SECURITY NOTES
 * - Never put SPREADSHEET_ID, IMGBB_API_KEY, or password hashes in frontend code.
 * - Volunteer accounts may submit new records and view only the status of their own
 *   submissions. They cannot search, list, or read household/member/health records.
 * - All authorization is enforced on the server. Hiding a frontend menu is not security.
 * - Health information and national ID numbers are sensitive personal data. Restrict
 *   deployment access, account creation, exports, and spreadsheet sharing accordingly.
 ****************************************************************************************/

// =====================================================================================
// 01. APPLICATION CONFIGURATION
// =====================================================================================

const APP_CONFIG = Object.freeze({
  NAME: 'ระบบแผนผังครอบครัวและฐานข้อมูลสุขภาพชุมชน รพ.สต.วัดเกาะ',
  VERSION: '1.0.0',
  TIME_ZONE: 'Asia/Bangkok',
  SESSION_TTL_SECONDS: 21600,            // 6 hours for ordinary sessions
  REMEMBER_SESSION_DAYS: 30,              // persistent login when Remember Me is selected
  LOGIN_MAX_FAILURES: 5,
  LOGIN_LOCK_MINUTES: 15,
  PASSWORD_ITERATIONS: 8000,             // PBKDF2-HMAC-SHA256 iteration count
  PASSWORD_MIN_LENGTH: 10,
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 200,
  MAX_IMAGE_BYTES: 8 * 1024 * 1024,      // 8 MB per image
  MAX_SEARCH_RESULTS: 100,
  CACHE_PREFIX: 'WATKOH_SESSION_',
  SESSION_VERSION: '1',
  ALLOWED_ROLES: ['ADMIN', 'OFFICER', 'VOLUNTEER'],
  ACTIVE_RECORD_STATUS: 'ACTIVE',
  DELETED_RECORD_STATUS: 'ARCHIVED'
});

const SCRIPT_PROPERTY_KEYS = Object.freeze({
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  IMGBB_API_KEY: 'IMGBB_API_KEY',
  SYSTEM_NAME: 'SYSTEM_NAME',
  SYSTEM_VERSION: 'SYSTEM_VERSION'
});

const ROLE_LABELS = Object.freeze({
  ADMIN: 'ผู้ดูแลระบบ',
  OFFICER: 'เจ้าหน้าที่',
  VOLUNTEER: 'อสม.'
});

const SHEET_HEADERS = Object.freeze({
  SETTINGS: [
    'setting_key', 'setting_value', 'description', 'updated_at', 'updated_by'
  ],

  USERS: [
    'user_id', 'username', 'password_hash', 'password_salt', 'password_iterations',
    'full_name', 'role', 'phone', 'email', 'assigned_moo', 'assigned_households_json',
    'is_active', 'must_change_password', 'last_login_at', 'failed_login_count',
    'locked_until', 'created_at', 'created_by', 'updated_at', 'updated_by', 'notes'
  ],

  SESSIONS: [
    'session_id', 'token_hash', 'user_id', 'session_version', 'created_at',
    'last_seen_at', 'expires_at', 'is_revoked', 'device_label'
  ],

  VILLAGES: [
    'village_id', 'moo', 'village_name', 'subdistrict', 'district', 'province',
    'postal_code', 'latitude', 'longitude', 'village_head_name', 'village_head_phone',
    'notes', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'
  ],

  HOUSEHOLDS: [
    'household_id', 'household_code', 'house_number', 'moo', 'soi', 'road',
    'subdistrict', 'district', 'province', 'postal_code', 'latitude', 'longitude',
    'household_head_member_id', 'household_head_name', 'household_status', 'risk_level',
    'house_photo_url', 'responsible_volunteer_id', 'responsible_volunteer_name',
    'responsible_officer_id', 'responsible_officer_name', 'member_count',
    'last_home_visit_date', 'next_followup_date', 'notes', 'created_at', 'created_by',
    'updated_at', 'updated_by', 'record_status'
  ],

  FAMILY_MEMBERS: [
    'member_id', 'household_id', 'national_id', 'title', 'first_name', 'last_name',
    'nickname', 'gender', 'date_of_birth', 'age', 'phone', 'relationship_to_head',
    'marital_status', 'religion', 'education', 'occupation', 'monthly_income',
    'health_right', 'health_right_hospital', 'disability_status', 'disability_type',
    'living_status', 'care_level', 'care_status', 'blood_group', 'drug_allergy', 'medical_history',
    'move_in_date', 'move_out_date', 'death_date', 'caregiver_member_id',
    'emergency_contact_name', 'emergency_contact_phone', 'photo_url', 'notes',
    'created_at', 'created_by', 'updated_at', 'updated_by', 'record_status'
  ],

  FAMILY_RELATIONS: [
    'relation_id', 'household_id', 'member_id', 'related_member_id', 'relation_type',
    'marriage_status', 'is_biological', 'valid_from', 'valid_to', 'genogram_line_type',
    'genogram_note', 'created_at', 'created_by', 'updated_at', 'updated_by', 'record_status'
  ],

  HEALTH_SCREENING: [
    'screening_id', 'member_id', 'household_id', 'screening_date', 'age_at_screening',
    'weight_kg', 'height_cm', 'bmi', 'waist_cm', 'hip_cm', 'systolic_bp', 'diastolic_bp',
    'pulse_rate', 'blood_glucose_fbs', 'blood_glucose_rbs', 'total_cholesterol',
    'triglycerides', 'hdl', 'ldl', 'urine_exam', 'stool_exam', 'breast_exam', 'eye_exam',
    'dental_exam', 'pap_smear', 'tt_status', 'hepatitis_b_status', 'physical_exam',
    'other_lab_results', 'smoking_status', 'alcohol_status',
    'exercise_frequency', 'diet_sweet', 'diet_fat', 'diet_salty', 'stress_level',
    'fall_risk', 'screening_result', 'abnormal_flag', 'abnormal_details', 'advice',
    'next_followup_date', 'provider_id', 'provider_name', 'attachments_json', 'notes',
    'created_at', 'created_by', 'updated_at', 'updated_by', 'record_status'
  ],

  CHRONIC_DISEASE: [
    'chronic_id', 'member_id', 'household_id', 'disease_code', 'disease_name',
    'diagnosis_date', 'diagnosis_hospital', 'treatment_hospital', 'medication',
    'treatment_plan', 'control_status', 'last_followup_date', 'next_followup_date',
    'complications', 'care_level', 'caregiver_member_id', 'referral_status',
    'referral_hospital', 'notes', 'created_at', 'created_by', 'updated_at', 'updated_by',
    'record_status'
  ],

  HEALTH_RISK: [
    'risk_id', 'member_id', 'household_id', 'assessment_date',
    'family_history_dm_ht_asthma', 'smoking_status', 'alcohol_status',
    'low_exercise', 'salty_food', 'fatty_food', 'sweet_food', 'obesity_risk',
    'stress_level', 'sexual_health_risk', 'fall_risk', 'other_risks_json',
    'overall_risk_level', 'advice', 'next_assessment_date', 'assessed_by',
    'assessed_by_name', 'notes', 'created_at', 'created_by', 'updated_at', 'updated_by',
    'record_status'
  ],

  VACCINATIONS: [
    'vaccination_id', 'member_id', 'household_id', 'vaccine_name', 'vaccine_code',
    'dose_number', 'vaccination_date', 'next_dose_date', 'provider_hospital',
    'lot_number', 'provider_id', 'provider_name', 'notes', 'created_at', 'created_by',
    'updated_at', 'updated_by', 'record_status'
  ],

  HOME_VISITS: [
    'visit_id', 'household_id', 'member_id', 'visit_date', 'visit_purpose', 'visit_type',
    'volunteer_id', 'volunteer_name', 'officer_id', 'officer_name', 'home_condition',
    'patient_condition', 'symptoms', 'problems_found', 'services_provided', 'advice_given',
    'referral_needed', 'referral_detail', 'followup_date', 'photo_urls_json',
    'attachments_json', 'latitude', 'longitude', 'visit_result', 'notes', 'created_at',
    'created_by', 'updated_at', 'updated_by', 'record_status'
  ],

  APPOINTMENTS: [
    'appointment_id', 'member_id', 'household_id', 'appointment_date', 'appointment_time',
    'appointment_type', 'service_location', 'provider_id', 'provider_name', 'purpose',
    'appointment_status', 'reminder_sent', 'result_note', 'created_at', 'created_by',
    'updated_at', 'updated_by', 'record_status'
  ],

  HOUSEHOLD_ASSIGNMENTS: [
    'assignment_id', 'household_id', 'volunteer_id', 'volunteer_name', 'officer_id',
    'officer_name', 'assigned_from', 'assigned_to', 'is_primary', 'notes', 'created_at',
    'created_by', 'updated_at', 'updated_by', 'record_status'
  ],

  APPROVAL_QUEUE: [
    'submission_id', 'client_temp_id', 'submitted_by', 'submitter_name', 'submitter_role',
    'entity_type', 'entity_id', 'action_type', 'payload_json', 'attachments_json',
    'submission_status', 'reviewed_by', 'reviewer_name', 'reviewed_at', 'review_note',
    'resolved_entity_id', 'parent_client_temp_id', 'created_at', 'updated_at'
  ],

  NOTIFICATIONS: [
    'notification_id', 'recipient_user_id', 'recipient_role', 'title', 'message',
    'notification_type', 'related_entity_type', 'related_entity_id', 'is_read',
    'read_at', 'created_at', 'created_by', 'expires_at'
  ],

  AUDIT_LOG: [
    'audit_id', 'event_time', 'user_id', 'username', 'full_name', 'role', 'action',
    'entity_type', 'entity_id', 'description', 'ip_hint', 'request_id', 'result'
  ],

  SYSTEM_LOG: [
    'system_log_id', 'event_time', 'level', 'component', 'message', 'details_json',
    'request_id'
  ],

  BACKUP_LOG: [
    'backup_id', 'backup_time', 'backup_type', 'requested_by', 'requested_by_name',
    'record_count', 'result', 'notes'
  ],

  LOOKUP_VALUES: [
    'lookup_id', 'lookup_group', 'lookup_code', 'lookup_label', 'sort_order',
    'is_active', 'notes', 'created_at', 'created_by', 'updated_at', 'updated_by'
  ]
});

const TABLE_ID_FIELDS = Object.freeze({
  HOUSEHOLDS: 'household_id',
  FAMILY_MEMBERS: 'member_id',
  FAMILY_RELATIONS: 'relation_id',
  HEALTH_SCREENING: 'screening_id',
  CHRONIC_DISEASE: 'chronic_id',
  HEALTH_RISK: 'risk_id',
  VACCINATIONS: 'vaccination_id',
  HOME_VISITS: 'visit_id',
  APPOINTMENTS: 'appointment_id',
  VILLAGES: 'village_id',
  HOUSEHOLD_ASSIGNMENTS: 'assignment_id'
});

const ENTITY_TABLE_MAP = Object.freeze({
  HOUSEHOLDS: 'HOUSEHOLDS',
  FAMILY_MEMBERS: 'FAMILY_MEMBERS',
  FAMILY_RELATIONS: 'FAMILY_RELATIONS',
  HEALTH_SCREENING: 'HEALTH_SCREENING',
  CHRONIC_DISEASE: 'CHRONIC_DISEASE',
  HEALTH_RISK: 'HEALTH_RISK',
  VACCINATIONS: 'VACCINATIONS',
  HOME_VISITS: 'HOME_VISITS',
  APPOINTMENTS: 'APPOINTMENTS'
});

const GET_ACTIONS = Object.freeze([
  // Only public, non-personal information can be requested through GET/JSONP.
  // Every authenticated read and every write must use POST.
  'system.health', 'system.info'
]);

const MUTATING_ACTIONS = Object.freeze([
  'auth.login', 'auth.logout', 'auth.changePassword',
  'users.create', 'users.update', 'users.resetPassword', 'users.toggle',
  'settings.update', 'lookups.save', 'villages.create', 'villages.update',
  'assignments.create', 'assignments.update', 'assignments.archive',
  'households.create', 'households.update', 'households.archive',
  'members.create', 'members.update', 'members.archive', 'members.move',
  'relations.create', 'relations.update', 'relations.delete',
  'health.screenings.create', 'health.screenings.update',
  'health.chronic.create', 'health.chronic.update',
  'health.risks.create', 'health.risks.update',
  'health.vaccinations.create', 'health.vaccinations.update',
  'visits.create', 'visits.update', 'appointments.create', 'appointments.update',
  'volunteer.submit', 'approvals.review', 'notifications.markRead',
  'backup.exportJson', 'import.bulk', 'system.clearSessions', 'system.installReminders'
]);

// =====================================================================================
// 02. WEB APP ENTRY POINTS AND API TRANSPORT
// =====================================================================================

/**
 * Public GET endpoint: only system.info and system.health are available through JSONP.
 * All authenticated reads and writes must use POST so session tokens do not appear in URLs.
 * Example:
 *   /exec?action=system.info&callback=handleResponse
 */
function doGet(e) {
  const requestId = createRequestId_();
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = String(params.action || 'system.info').trim();
    const callback = sanitizeJsonpCallback_(params.callback || '');
    const data = parseJsonParameter_(params.data || '{}');

    if (GET_ACTIONS.indexOf(action) === -1) {
      return jsonOrJsonp_({
        success: false,
        message: 'ไม่อนุญาตให้ดำเนินการผ่านคำขอแบบอ่านข้อมูล',
        requestId: requestId
      }, callback);
    }

    data.action = action;
    data.requestId = requestId;
    const result = handleApiRequest_(data, 'GET');
    return jsonOrJsonp_(result, callback);
  } catch (error) {
    writeSystemLog_('ERROR', 'doGet', 'คำขอข้อมูลไม่สำเร็จ', error, requestId);
    return jsonOrJsonp_({
      success: false,
      message: 'ไม่สามารถเรียกดูข้อมูลได้ กรุณาลองใหม่อีกครั้ง',
      requestId: requestId
    }, '');
  }
}

/**
 * POST endpoint: submit a form-encoded field named "payload" containing JSON.
 * The response HTML sends postMessage to the parent. Cloudflare Worker forwards this
 * HTML response unchanged; the GitHub frontend receives it from its Worker-targeted iframe.
 */
function doPost(e) {
  const requestId = createRequestId_();
  let suppliedNonce = '';
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const rawPayload = params.payload || params.data || '';
    const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload || '{}') : rawPayload;
    suppliedNonce = String(payload.nonce || params.nonce || '');
    payload.requestId = requestId;
    const result = handleApiRequest_(payload, 'POST');
    return postMessageHtml_(result, requestId, suppliedNonce);
  } catch (error) {
    writeSystemLog_('ERROR', 'doPost', 'คำขอปรับปรุงข้อมูลไม่สำเร็จ', error, requestId);
    return postMessageHtml_({
      success: false,
      message: 'ไม่สามารถบันทึกข้อมูลได้ กรุณาตรวจสอบข้อมูลแล้วลองใหม่',
      requestId: requestId
    }, requestId, suppliedNonce);
  }
}

function jsonOrJsonp_(object, callback) {
  const json = JSON.stringify(toJsonSafe_(object));
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function postMessageHtml_(result, requestId, nonce) {
  const safePayload = JSON.stringify(toJsonSafe_(result))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const safeRequestId = JSON.stringify(String(requestId || ''));
  const safeNonce = JSON.stringify(String(nonce || ''));
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    '<script>',
    '(function(){',
    'var message={__watkSystem:true,requestId:' + safeRequestId + ',nonce:' + safeNonce + ',payload:' + safePayload + '};',
    'try{window.top.postMessage(message,"*");}catch(e){try{window.parent.postMessage(message,"*");}catch(ignore){}}',
    '})();',
    '</script>',
    '<p>ดำเนินการเรียบร้อยแล้ว สามารถปิดหน้าต่างนี้ได้</p>',
    '</body></html>'
  ].join('');
  return HtmlService.createHtmlOutput(html)
    .setTitle('ระบบข้อมูลสุขภาพชุมชน')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function sanitizeJsonpCallback_(callback) {
  const value = String(callback || '').trim();
  if (!value) return '';
  return /^[A-Za-z_$][A-Za-z0-9_$\.]{0,100}$/.test(value) ? value : '';
}

function parseJsonParameter_(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || '{}'));
  } catch (error) {
    throw new Error('INVALID_JSON');
  }
}

// =====================================================================================
// 03. API ROUTER AND CENTRAL ERROR HANDLING
// =====================================================================================

function handleApiRequest_(request, method) {
  const req = request || {};
  const action = String(req.action || '').trim();
  const requestId = String(req.requestId || createRequestId_());
  const data = req.data && typeof req.data === 'object' ? req.data : req;
  const token = String(req.token || data.token || '');
  let lock = null;

  try {
    if (!action) return apiError_('ไม่พบรายการที่ต้องการดำเนินการ', requestId);
    if (method === 'GET' && GET_ACTIONS.indexOf(action) === -1) {
      return apiError_('ไม่อนุญาตให้ดำเนินการนี้', requestId);
    }

    ensureDatabaseReady_();
    if (method === 'POST' && MUTATING_ACTIONS.indexOf(action) !== -1) {
      lock = LockService.getScriptLock();
      lock.waitLock(30000);
    }
    const result = dispatchAction_(action, data, token, requestId);
    return apiSuccess_(result, requestId);
  } catch (error) {
    const publicMessage = getPublicErrorMessage_(error);
    writeSystemLog_('ERROR', 'API:' + action, String(error && error.message ? error.message : error), error, requestId);
    return apiError_(publicMessage, requestId);
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (ignored) { /* lock may already be released */ }
    }
  }
}

function dispatchAction_(action, data, token, requestId) {
  switch (action) {
    // System and authentication
    case 'system.health': return actionSystemHealth_();
    case 'system.info': return actionSystemInfo_();
    case 'system.clearSessions': return actionSystemClearSessions_(token);
    case 'system.installReminders': return actionSystemInstallReminders_(token);
    case 'system.logs.list': return actionSystemLogsList_(token, data);
    case 'auth.login': return actionAuthLogin_(data, requestId);
    case 'auth.logout': return actionAuthLogout_(token);
    case 'auth.me': return actionAuthMe_(token);
    case 'auth.changePassword': return actionAuthChangePassword_(token, data);

    // User and village administration
    case 'users.list': return actionUsersList_(token, data);
    case 'users.create': return actionUsersCreate_(token, data);
    case 'users.update': return actionUsersUpdate_(token, data);
    case 'users.resetPassword': return actionUsersResetPassword_(token, data);
    case 'users.toggle': return actionUsersToggle_(token, data);
    case 'settings.list': return actionSettingsList_(token, data);
    case 'settings.update': return actionSettingsUpdate_(token, data);
    case 'lookups.list': return actionLookupsList_(token, data);
    case 'lookups.save': return actionLookupsSave_(token, data);
    case 'villages.list': return actionVillagesList_(token, data);
    case 'villages.create': return actionVillagesCreate_(token, data);
    case 'villages.update': return actionVillagesUpdate_(token, data);
    case 'assignments.list': return actionAssignmentsList_(token, data);
    case 'assignments.create': return actionEntityCreate_(token, 'HOUSEHOLD_ASSIGNMENTS', data);
    case 'assignments.update': return actionEntityUpdate_(token, 'HOUSEHOLD_ASSIGNMENTS', data);
    case 'assignments.archive': return actionEntityArchive_(token, 'HOUSEHOLD_ASSIGNMENTS', data);

    // Household management
    case 'households.list': return actionHouseholdsList_(token, data);
    case 'households.get': return actionHouseholdsGet_(token, data);
    case 'households.dossier': return actionHouseholdDossier_(token, data);
    case 'households.create': return actionEntityCreate_(token, 'HOUSEHOLDS', data);
    case 'households.update': return actionEntityUpdate_(token, 'HOUSEHOLDS', data);
    case 'households.archive': return actionEntityArchive_(token, 'HOUSEHOLDS', data);

    // Member management
    case 'members.list': return actionMembersList_(token, data);
    case 'members.get': return actionMembersGet_(token, data);
    case 'members.create': return actionEntityCreate_(token, 'FAMILY_MEMBERS', data);
    case 'members.update': return actionEntityUpdate_(token, 'FAMILY_MEMBERS', data);
    case 'members.archive': return actionEntityArchive_(token, 'FAMILY_MEMBERS', data);
    case 'members.move': return actionMemberMove_(token, data);

    // Genogram / family relations
    case 'relations.list': return actionRelationsList_(token, data);
    case 'relations.create': return actionEntityCreate_(token, 'FAMILY_RELATIONS', data);
    case 'relations.update': return actionEntityUpdate_(token, 'FAMILY_RELATIONS', data);
    case 'relations.delete': return actionEntityArchive_(token, 'FAMILY_RELATIONS', data);

    // Health records
    case 'health.screenings.list': return actionHealthList_(token, 'HEALTH_SCREENING', data);
    case 'health.screenings.create': return actionEntityCreate_(token, 'HEALTH_SCREENING', data);
    case 'health.screenings.update': return actionEntityUpdate_(token, 'HEALTH_SCREENING', data);
    case 'health.chronic.list': return actionHealthList_(token, 'CHRONIC_DISEASE', data);
    case 'health.chronic.create': return actionEntityCreate_(token, 'CHRONIC_DISEASE', data);
    case 'health.chronic.update': return actionEntityUpdate_(token, 'CHRONIC_DISEASE', data);
    case 'health.risks.list': return actionHealthList_(token, 'HEALTH_RISK', data);
    case 'health.risks.create': return actionEntityCreate_(token, 'HEALTH_RISK', data);
    case 'health.risks.update': return actionEntityUpdate_(token, 'HEALTH_RISK', data);
    case 'health.vaccinations.list': return actionHealthList_(token, 'VACCINATIONS', data);
    case 'health.vaccinations.create': return actionEntityCreate_(token, 'VACCINATIONS', data);
    case 'health.vaccinations.update': return actionEntityUpdate_(token, 'VACCINATIONS', data);

    // Home visits and appointments
    case 'visits.list': return actionVisitsList_(token, data);
    case 'visits.create': return actionEntityCreate_(token, 'HOME_VISITS', data);
    case 'visits.update': return actionEntityUpdate_(token, 'HOME_VISITS', data);
    case 'appointments.list': return actionAppointmentsList_(token, data);
    case 'appointments.create': return actionEntityCreate_(token, 'APPOINTMENTS', data);
    case 'appointments.update': return actionEntityUpdate_(token, 'APPOINTMENTS', data);

    // Volunteer submissions and review
    case 'volunteer.submit': return actionVolunteerSubmit_(token, data);
    case 'volunteer.mySubmissions': return actionVolunteerMySubmissions_(token, data);
    case 'approvals.list': return actionApprovalsList_(token, data);
    case 'approvals.review': return actionApprovalReview_(token, data);

    // Search, dashboard, notifications and reports
    case 'search.global': return actionGlobalSearch_(token, data);
    case 'dashboard.stats': return actionDashboardStats_(token, data);
    case 'notifications.list': return actionNotificationsList_(token, data);
    case 'notifications.markRead': return actionNotificationMarkRead_(token, data);
    case 'reports.data': return actionReportsData_(token, data);
    case 'reports.exportData': return actionReportsExportData_(token, data);
    case 'audit.list': return actionAuditList_(token, data);

    // Image hosting and backup
    case 'files.uploadImage': return actionUploadImage_(token, data);
    case 'backup.exportJson': return actionBackupExportJson_(token, data);
    case 'import.bulk': return actionBulkImport_(token, data);

    default:
      throw new Error('UNKNOWN_ACTION');
  }
}

function apiSuccess_(data, requestId) {
  return { success: true, data: toJsonSafe_(data), message: 'ดำเนินการเรียบร้อยแล้ว', requestId: requestId };
}

function apiError_(message, requestId) {
  return { success: false, data: null, message: message || 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง', requestId: requestId };
}

function getPublicErrorMessage_(error) {
  const code = String(error && error.message ? error.message : error || '');
  const known = {
    'AUTH_REQUIRED': 'กรุณาเข้าสู่ระบบก่อนใช้งาน',
    'INVALID_CREDENTIALS': 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
    'ACCOUNT_DISABLED': 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
    'ACCOUNT_LOCKED': 'บัญชีถูกระงับชั่วคราวเนื่องจากเข้าสู่ระบบไม่สำเร็จหลายครั้ง',
    'PERMISSION_DENIED': 'คุณไม่มีสิทธิ์ดำเนินการในส่วนนี้',
    'NOT_FOUND': 'ไม่พบข้อมูลที่ต้องการ',
    'DUPLICATE_RECORD': 'พบข้อมูลนี้ในระบบแล้ว กรุณาตรวจสอบก่อนบันทึก',
    'INVALID_NATIONAL_ID': 'เลขบัตรประชาชนไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง',
    'INVALID_INPUT': 'กรุณาตรวจสอบข้อมูลที่กรอกให้ถูกต้องและครบถ้วน',
    'INVALID_PASSWORD': 'รหัสผ่านใหม่ไม่เป็นไปตามเงื่อนไขที่กำหนด',
    'INITIAL_ADMIN_ALREADY_EXISTS': 'มีบัญชีผู้ดูแลระบบอยู่แล้ว กรุณาใช้บัญชีเดิมหรือรีเซ็ตรหัสผ่าน',
    'LAST_ADMIN_REQUIRED': 'ต้องมีบัญชีผู้ดูแลระบบที่เปิดใช้งานอย่างน้อยหนึ่งบัญชี',
    'UNKNOWN_ACTION': 'ไม่พบฟังก์ชันที่ต้องการใช้งาน',
    'IMG_UPLOAD_NOT_CONFIGURED': 'ระบบจัดเก็บรูปภาพยังไม่ได้ตั้งค่า กรุณาติดต่อผู้ดูแลระบบ',
    'IMG_UPLOAD_FAILED': 'ไม่สามารถอัปโหลดรูปภาพได้ กรุณาลองใหม่อีกครั้ง',
    'IMAGE_TOO_LARGE': 'รูปภาพมีขนาดใหญ่เกินกำหนด กรุณาเลือกรูปภาพที่มีขนาดไม่เกิน 8 MB',
    'SUBMISSION_NOT_FOUND': 'ไม่พบรายการที่ต้องการตรวจสอบ',
    'INVALID_REVIEW_STATUS': 'สถานะการตรวจสอบไม่ถูกต้อง',
    'VOLUNTEER_CREATE_ONLY': 'อสม. สามารถส่งข้อมูลใหม่เพื่อรอตรวจสอบได้เท่านั้น',
    'SPREADSHEET_NOT_READY': 'ฐานข้อมูลยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ'
  };
  return known[code] || 'ไม่สามารถดำเนินการได้ กรุณาตรวจสอบข้อมูลและลองใหม่อีกครั้ง';
}

// =====================================================================================
// 04. DATABASE INITIALIZATION AND AUTOMATIC HEADER CREATION
// =====================================================================================

/** Run this once manually from Apps Script editor. Safe to run repeatedly. */
function initializeSystem() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getOrCreateSpreadsheet_();
    Object.keys(SHEET_HEADERS).forEach(function (sheetName) {
      ensureSheetSchema_(spreadsheet, sheetName, SHEET_HEADERS[sheetName]);
    });
    seedDefaultSettings_();
    seedDefaultLookupValues_();
    PropertiesService.getScriptProperties().setProperty(SCRIPT_PROPERTY_KEYS.SYSTEM_NAME, APP_CONFIG.NAME);
    PropertiesService.getScriptProperties().setProperty(SCRIPT_PROPERTY_KEYS.SYSTEM_VERSION, APP_CONFIG.VERSION);
    SpreadsheetApp.flush();
    return {
      success: true,
      message: 'สร้างฐานข้อมูลและหัวตารางอัตโนมัติเรียบร้อยแล้ว',
      spreadsheetId: spreadsheet.getId(),
      spreadsheetUrl: spreadsheet.getUrl(),
      sheets: Object.keys(SHEET_HEADERS)
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Create the first administrator manually from Apps Script editor.
 * Example: createInitialAdmin('admin', 'YourStrongPassword123!', 'ผู้ดูแลระบบ')
 * This function refuses to create a second initial administrator.
 */
function createInitialAdmin(username, password, fullName) {
  ensureDatabaseReady_();
  const cleanUsername = String(username || '').trim();
  const cleanPassword = String(password || '');
  if (!cleanUsername || cleanPassword.length < APP_CONFIG.PASSWORD_MIN_LENGTH) {
    throw new Error('INVALID_PASSWORD');
  }
  const users = getRows_('USERS');
  if (users.some(function (u) { return String(u.role) === 'ADMIN' && normalizeBoolean_(u.is_active); })) {
    throw new Error('INITIAL_ADMIN_ALREADY_EXISTS');
  }
  if (users.some(function (u) { return String(u.username).toLowerCase() === cleanUsername.toLowerCase(); })) {
    throw new Error('DUPLICATE_RECORD');
  }
  const salt = createSalt_();
  const now = nowIso_();
  appendRecord_('USERS', {
    user_id: generateId_('USR'),
    username: cleanUsername,
    password_hash: hashPassword_(cleanPassword, salt, APP_CONFIG.PASSWORD_ITERATIONS),
    password_salt: salt,
    password_iterations: APP_CONFIG.PASSWORD_ITERATIONS,
    full_name: String(fullName || 'ผู้ดูแลระบบ').trim(),
    role: 'ADMIN',
    is_active: true,
    must_change_password: false,
    failed_login_count: 0,
    created_at: now,
    created_by: 'SYSTEM',
    updated_at: now,
    updated_by: 'SYSTEM'
  });
  return 'สร้างบัญชีผู้ดูแลระบบเรียบร้อยแล้ว กรุณาเก็บรหัสผ่านไว้ในที่ปลอดภัย';
}

/** Recheck schema and add newly introduced columns without deleting existing data. */
function ensureDatabaseReady_() {
  const schemaCache = CacheService.getScriptCache();
  const schemaCacheKey = 'WATKOH_SCHEMA_READY_' + APP_CONFIG.VERSION;
  if (schemaCache.get(schemaCacheKey) === '1') return;
  try {
    const spreadsheet = getOrCreateSpreadsheet_();
    Object.keys(SHEET_HEADERS).forEach(function (sheetName) {
      ensureSheetSchema_(spreadsheet, sheetName, SHEET_HEADERS[sheetName]);
    });
    schemaCache.put(schemaCacheKey, '1', 900);
  } catch (error) {
    writeSystemLog_('ERROR', 'Database', 'ไม่สามารถเตรียมฐานข้อมูลได้', error, '');
    throw new Error('SPREADSHEET_NOT_READY');
  }
}

function getOrCreateSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  let spreadsheetId = properties.getProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID);
  if (spreadsheetId) {
    try {
      return SpreadsheetApp.openById(spreadsheetId);
    } catch (error) {
      throw new Error('SPREADSHEET_NOT_READY');
    }
  }
  const systemName = properties.getProperty(SCRIPT_PROPERTY_KEYS.SYSTEM_NAME) || APP_CONFIG.NAME;
  const spreadsheet = SpreadsheetApp.create(systemName);
  properties.setProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID, spreadsheet.getId());
  const defaultSheet = spreadsheet.getSheets()[0];
  defaultSheet.setName('SETTINGS');
  return spreadsheet;
}

function ensureSheetSchema_(spreadsheet, sheetName, requiredHeaders) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);

  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const firstRow = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const hasHeader = firstRow.some(function (value) { return String(value || '').trim() !== ''; });

  if (!hasHeader) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
  } else {
    const existing = firstRow.map(function (value) { return String(value || '').trim(); });
    const missing = requiredHeaders.filter(function (header) { return existing.indexOf(header) === -1; });
    if (missing.length) {
      sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
  }

  const activeHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, activeHeaders.length)
    .setFontWeight('bold')
    .setWrap(true)
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);
  if (!sheet.getFilter() && sheet.getLastRow() > 1) {
    sheet.getRange(1, 1, sheet.getLastRow(), activeHeaders.length).createFilter();
  }
  return sheet;
}

function seedDefaultSettings_() {
  const defaults = [
    ['SYSTEM_NAME', APP_CONFIG.NAME, 'ชื่อระบบ'],
    ['SYSTEM_VERSION', APP_CONFIG.VERSION, 'เวอร์ชันของระบบ'],
    ['ORGANIZATION_NAME', 'โรงพยาบาลส่งเสริมสุขภาพตำบลวัดเกาะ', 'ชื่อหน่วยบริการ'],
    ['SUBDISTRICT', 'วัดเกาะ', 'ตำบล'],
    ['DISTRICT', 'ศรีสำโรง', 'อำเภอ'],
    ['PROVINCE', 'สุโขทัย', 'จังหวัด'],
    ['TIME_ZONE', APP_CONFIG.TIME_ZONE, 'เขตเวลา'],
    ['DEFAULT_MOO', '1', 'หมู่บ้านเริ่มต้น'],
    ['DATA_RETENTION_NOTE', 'กำหนดระยะเวลาเก็บรักษาข้อมูลตามนโยบายของหน่วยบริการ', 'หมายเหตุการเก็บรักษาข้อมูล']
  ];
  const existing = getRows_('SETTINGS');
  const existingKeys = existing.map(function (row) { return String(row.setting_key); });
  const now = nowIso_();
  defaults.forEach(function (item) {
    if (existingKeys.indexOf(item[0]) === -1) {
      appendRecord_('SETTINGS', {
        setting_key: item[0], setting_value: item[1], description: item[2],
        updated_at: now, updated_by: 'SYSTEM'
      });
    }
  });
}

function seedDefaultLookupValues_() {
  const values = [
    ['ROLE', 'ADMIN', 'ผู้ดูแลระบบ', 1],
    ['ROLE', 'OFFICER', 'เจ้าหน้าที่', 2],
    ['ROLE', 'VOLUNTEER', 'อสม.', 3],
    ['HOUSEHOLD_STATUS', 'NORMAL', 'ปกติ', 1],
    ['HOUSEHOLD_STATUS', 'FOLLOW_UP', 'ต้องติดตาม', 2],
    ['HOUSEHOLD_STATUS', 'NO_RESIDENT', 'ไม่มีผู้อยู่อาศัย', 3],
    ['RISK_LEVEL', 'LOW', 'ต่ำ', 1],
    ['RISK_LEVEL', 'MEDIUM', 'ปานกลาง', 2],
    ['RISK_LEVEL', 'HIGH', 'สูง', 3],
    ['GENDER', 'MALE', 'ชาย', 1],
    ['GENDER', 'FEMALE', 'หญิง', 2],
    ['GENDER', 'OTHER', 'อื่น ๆ', 3],
    ['LIVING_STATUS', 'ALIVE', 'มีชีวิต', 1],
    ['LIVING_STATUS', 'DECEASED', 'เสียชีวิต', 2],
    ['LIVING_STATUS', 'MOVED_OUT', 'ย้ายออก', 3],
    ['SUBMISSION_STATUS', 'PENDING', 'รอตรวจสอบ', 1],
    ['SUBMISSION_STATUS', 'APPROVED', 'อนุมัติ', 2],
    ['SUBMISSION_STATUS', 'REJECTED', 'ส่งกลับ/ไม่อนุมัติ', 3],
    ['DISEASE', 'DM', 'เบาหวาน', 1],
    ['DISEASE', 'HT', 'ความดันโลหิตสูง', 2],
    ['DISEASE', 'GOUT', 'เกาต์', 3],
    ['DISEASE', 'STROKE', 'โรคหลอดเลือดสมอง', 4],
    ['DISEASE', 'IHD_CHF', 'โรคหัวใจ/หัวใจล้มเหลว', 5],
    ['DISEASE', 'ASTHMA_COPD', 'หอบหืด/COPD', 6],
    ['DISEASE', 'OTHER', 'โรคอื่น ๆ', 99]
  ];
  const existing = getRows_('LOOKUP_VALUES');
  const keys = existing.map(function (row) {
    return [row.lookup_group, row.lookup_code].join('|');
  });
  const now = nowIso_();
  values.forEach(function (item) {
    const key = item[0] + '|' + item[1];
    if (keys.indexOf(key) === -1) {
      appendRecord_('LOOKUP_VALUES', {
        lookup_id: generateId_('LKP'), lookup_group: item[0], lookup_code: item[1],
        lookup_label: item[2], sort_order: item[3], is_active: true,
        created_at: now, created_by: 'SYSTEM', updated_at: now, updated_by: 'SYSTEM'
      });
    }
  });
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID);
  if (!id) throw new Error('SPREADSHEET_NOT_READY');
  return SpreadsheetApp.openById(id);
}

function getSheet_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('SPREADSHEET_NOT_READY');
  return sheet;
}

// =====================================================================================
// 05. CORE SHEET READ / WRITE HELPERS
// =====================================================================================

function getRows_(sheetName) {
  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = values[0].map(function (header) { return String(header || '').trim(); });
  const output = [];
  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    const row = values[rowIndex];
    if (row.every(function (cell) { return cell === '' || cell === null; })) continue;
    const item = {};
    headers.forEach(function (header, columnIndex) {
      if (header) item[header] = toJsonSafe_(row[columnIndex]);
    });
    item.__rowNumber = rowIndex + 1;
    output.push(item);
  }
  return output;
}

function getHeaders_(sheetName) {
  const sheet = getSheet_(sheetName);
  const lastColumn = sheet.getLastColumn();
  return lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(String) : [];
}

function appendRecord_(sheetName, record) {
  const sheet = getSheet_(sheetName);
  const headers = getHeaders_(sheetName);
  const row = headers.map(function (header) {
    return safeCellValue_(Object.prototype.hasOwnProperty.call(record, header) ? record[header] : '');
  });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function updateRecordById_(sheetName, idField, idValue, patch) {
  const sheet = getSheet_(sheetName);
  const records = getRows_(sheetName);
  const record = records.find(function (item) { return String(item[idField]) === String(idValue); });
  if (!record) throw new Error('NOT_FOUND');
  const headers = getHeaders_(sheetName);
  const rowNumber = Number(record.__rowNumber);
  headers.forEach(function (header, index) {
    if (Object.prototype.hasOwnProperty.call(patch, header)) {
      sheet.getRange(rowNumber, index + 1).setValue(safeCellValue_(patch[header]));
    }
  });
  return getRecordById_(sheetName, idField, idValue);
}

function getRecordById_(sheetName, idField, idValue) {
  const rows = getRows_(sheetName);
  const result = rows.find(function (row) { return String(row[idField]) === String(idValue); });
  if (!result) throw new Error('NOT_FOUND');
  delete result.__rowNumber;
  return result;
}

function safeCellValue_(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const text = String(value);
  if (/^[=+@\-\t\r]/.test(text)) return "'" + text;
  return text;
}

function filterActive_(rows) {
  return rows.filter(function (row) {
    const status = String(row.record_status || APP_CONFIG.ACTIVE_RECORD_STATUS).toUpperCase();
    return status !== APP_CONFIG.DELETED_RECORD_STATUS && status !== 'DELETED';
  });
}

function paginate_(rows, page, pageSize) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeSize = Math.min(APP_CONFIG.MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize, 10) || APP_CONFIG.DEFAULT_PAGE_SIZE));
  const total = rows.length;
  const start = (safePage - 1) * safeSize;
  return {
    items: rows.slice(start, start + safeSize).map(function (item) {
      const copy = Object.assign({}, item);
      delete copy.__rowNumber;
      return copy;
    }),
    page: safePage,
    pageSize: safeSize,
    total: total,
    totalPages: Math.ceil(total / safeSize)
  };
}

function sanitizeFields_(sheetName, input, isCreate) {
  const headers = getHeaders_(sheetName);
  const blocked = ['created_at', 'created_by', 'updated_at', 'updated_by', 'record_status'];
  const primaryKey = TABLE_ID_FIELDS[sheetName];
  if (primaryKey) blocked.push(primaryKey);
  const output = {};
  Object.keys(input || {}).forEach(function (key) {
    if (headers.indexOf(key) !== -1 && blocked.indexOf(key) === -1) {
      output[key] = input[key];
    }
  });
  if (isCreate && headers.indexOf('record_status') !== -1) {
    output.record_status = APP_CONFIG.ACTIVE_RECORD_STATUS;
  }
  return output;
}

function generateId_(prefix) {
  return String(prefix || 'REC') + '_' + Utilities.getUuid().replace(/-/g, '').toUpperCase();
}

function createRequestId_() {
  return 'REQ_' + Utilities.getUuid().replace(/-/g, '').substring(0, 16).toUpperCase();
}

function nowIso_() {
  return Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function toJsonSafe_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, APP_CONFIG.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  if (Array.isArray(value)) return value.map(toJsonSafe_);
  if (value && typeof value === 'object') {
    const output = {};
    Object.keys(value).forEach(function (key) {
      if (key === '__rowNumber') return;
      output[key] = toJsonSafe_(value[key]);
    });
    return output;
  }
  return value;
}

function parseJsonField_(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch (error) { return fallback; }
}

function normalizeBoolean_(value) {
  return value === true || ['true', '1', 'yes', 'ใช่', 'มี', 'จริง'].indexOf(String(value).toLowerCase()) !== -1;
}

// =====================================================================================
// 06. AUTHENTICATION, PASSWORD HASHING AND SESSION MANAGEMENT
// =====================================================================================

function actionAuthLogin_(data, requestId) {
  const username = String(data.username || '').trim();
  const password = String(data.password || '');
  if (!username || !password) throw new Error('INVALID_CREDENTIALS');

  const users = getRows_('USERS');
  const user = users.find(function (item) {
    return String(item.username || '').toLowerCase() === username.toLowerCase();
  });
  if (!user) {
    Utilities.sleep(250);
    throw new Error('INVALID_CREDENTIALS');
  }
  if (!normalizeBoolean_(user.is_active)) throw new Error('ACCOUNT_DISABLED');
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) throw new Error('ACCOUNT_LOCKED');

  const iterations = Math.max(1000, parseInt(user.password_iterations, 10) || APP_CONFIG.PASSWORD_ITERATIONS);
  const candidate = hashPassword_(password, String(user.password_salt || ''), iterations);
  if (candidate !== String(user.password_hash || '')) {
    const failed = (parseInt(user.failed_login_count, 10) || 0) + 1;
    const patch = { failed_login_count: failed, updated_at: nowIso_(), updated_by: 'SYSTEM' };
    if (failed >= APP_CONFIG.LOGIN_MAX_FAILURES) {
      patch.locked_until = new Date(Date.now() + APP_CONFIG.LOGIN_LOCK_MINUTES * 60000).toISOString();
      patch.failed_login_count = 0;
    }
    updateRecordById_('USERS', 'user_id', user.user_id, patch);
    auditLog_(null, 'AUTH_LOGIN_FAILED', 'USER', user.user_id, 'เข้าสู่ระบบไม่สำเร็จ', requestId, 'DENIED');
    throw new Error(failed >= APP_CONFIG.LOGIN_MAX_FAILURES ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS');
  }

  const rememberMe = normalizeBoolean_(data.rememberMe !== undefined ? data.rememberMe : data.remember_me);
  const token = createSession_(user, rememberMe, String(data.deviceLabel || ''));
  updateRecordById_('USERS', 'user_id', user.user_id, {
    failed_login_count: 0,
    locked_until: '',
    last_login_at: nowIso_(),
    updated_at: nowIso_(),
    updated_by: user.user_id
  });
  auditLog_(user, 'AUTH_LOGIN', 'USER', user.user_id, 'เข้าสู่ระบบสำเร็จ', requestId, 'SUCCESS');
  return {
    token: token,
    expiresIn: rememberMe ? APP_CONFIG.REMEMBER_SESSION_DAYS * 86400 : APP_CONFIG.SESSION_TTL_SECONDS,
    rememberMe: rememberMe,
    user: publicUser_(user),
    mustChangePassword: normalizeBoolean_(user.must_change_password)
  };
}

function actionAuthLogout_(token) {
  if (token) {
    CacheService.getScriptCache().remove(APP_CONFIG.CACHE_PREFIX + token);
    const tokenHash = hashSessionToken_(token);
    const persistent = getRows_('SESSIONS').find(function (row) {
      return String(row.token_hash) === tokenHash && !normalizeBoolean_(row.is_revoked);
    });
    if (persistent) {
      updateRecordById_('SESSIONS', 'session_id', persistent.session_id, { is_revoked: true, last_seen_at: nowIso_() });
    }
  }
  return { loggedOut: true };
}

function actionAuthMe_(token) {
  const user = requireAuth_(token);
  return { user: publicUser_(user), roleLabel: ROLE_LABELS[user.role] || user.role };
}

function actionAuthChangePassword_(token, data) {
  const user = requireAuth_(token);
  const oldPassword = String(data.oldPassword || '');
  const newPassword = String(data.newPassword || '');
  if (newPassword.length < APP_CONFIG.PASSWORD_MIN_LENGTH) throw new Error('INVALID_PASSWORD');
  if (hashPassword_(oldPassword, String(user.password_salt), parseInt(user.password_iterations, 10) || APP_CONFIG.PASSWORD_ITERATIONS) !== String(user.password_hash)) {
    throw new Error('INVALID_CREDENTIALS');
  }
  const salt = createSalt_();
  updateRecordById_('USERS', 'user_id', user.user_id, {
    password_hash: hashPassword_(newPassword, salt, APP_CONFIG.PASSWORD_ITERATIONS),
    password_salt: salt,
    password_iterations: APP_CONFIG.PASSWORD_ITERATIONS,
    must_change_password: false,
    updated_at: nowIso_(), updated_by: user.user_id
  });
  auditLog_(user, 'AUTH_PASSWORD_CHANGE', 'USER', user.user_id, 'เปลี่ยนรหัสผ่าน', '', 'SUCCESS');
  return { changed: true };
}

function createSession_(user, rememberMe, deviceLabel) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  const session = {
    user_id: String(user.user_id),
    role: String(user.role),
    username: String(user.username),
    version: getSessionVersion_(),
    created_at: nowIso_()
  };
  const cache = CacheService.getScriptCache();
  cache.put(APP_CONFIG.CACHE_PREFIX + token, JSON.stringify(session), APP_CONFIG.SESSION_TTL_SECONDS);

  if (rememberMe) {
    const now = new Date();
    const expiry = new Date(now.getTime() + APP_CONFIG.REMEMBER_SESSION_DAYS * 86400000);
    appendRecord_('SESSIONS', {
      session_id: generateId_('SES'),
      token_hash: hashSessionToken_(token),
      user_id: user.user_id,
      session_version: session.version,
      created_at: nowIso_(),
      last_seen_at: nowIso_(),
      expires_at: expiry.toISOString(),
      is_revoked: false,
      device_label: String(deviceLabel || '').substring(0, 150)
    });
  }
  return token;
}

function requireAuth_(token) {
  if (!token) throw new Error('AUTH_REQUIRED');
  const cache = CacheService.getScriptCache();
  const cacheKey = APP_CONFIG.CACHE_PREFIX + token;
  let raw = cache.get(cacheKey);
  let session = raw ? JSON.parse(raw) : null;

  if (!session) {
    // Persistent sessions are stored as one-way token hashes, never as raw tokens.
    const tokenHash = hashSessionToken_(token);
    const persistent = getRows_('SESSIONS').find(function (row) {
      return String(row.token_hash) === tokenHash && !normalizeBoolean_(row.is_revoked);
    });
    if (!persistent || !persistent.expires_at || new Date(persistent.expires_at).getTime() <= Date.now()) {
      throw new Error('AUTH_REQUIRED');
    }
    if (String(persistent.session_version) !== getSessionVersion_()) throw new Error('AUTH_REQUIRED');
    session = {
      user_id: String(persistent.user_id),
      version: String(persistent.session_version),
      created_at: String(persistent.created_at || '')
    };
    const secondsLeft = Math.floor((new Date(persistent.expires_at).getTime() - Date.now()) / 1000);
    cache.put(cacheKey, JSON.stringify(session), Math.max(1, Math.min(APP_CONFIG.SESSION_TTL_SECONDS, secondsLeft)));
    updateRecordById_('SESSIONS', 'session_id', persistent.session_id, { last_seen_at: nowIso_() });
  }

  if (session.version !== getSessionVersion_()) throw new Error('AUTH_REQUIRED');
  const user = getRows_('USERS').find(function (item) { return String(item.user_id) === String(session.user_id); });
  if (!user || !normalizeBoolean_(user.is_active)) {
    cache.remove(cacheKey);
    throw new Error('AUTH_REQUIRED');
  }
  return user;
}

function hashSessionToken_(token) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function requireRole_(token, roles) {
  const user = requireAuth_(token);
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (allowed.indexOf(String(user.role)) === -1) throw new Error('PERMISSION_DENIED');
  return user;
}

function publicUser_(user) {
  const output = Object.assign({}, user);
  [
    'password_hash', 'password_salt', 'password_iterations', 'failed_login_count',
    'locked_until', '__rowNumber'
  ].forEach(function (key) { delete output[key]; });
  output.role_label = ROLE_LABELS[user.role] || user.role;
  return toJsonSafe_(output);
}

function createSalt_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

/** PBKDF2-HMAC-SHA256 implemented using Apps Script Utilities. */
function hashPassword_(password, salt, iterations) {
  const passwordBytes = Utilities.newBlob(String(password), 'text/plain').getBytes();
  const saltBytes = Utilities.newBlob(String(salt), 'text/plain').getBytes();
  const blockBytes = saltBytes.concat([0, 0, 0, 1]);
  let u = Utilities.computeHmacSha256Signature(blockBytes, passwordBytes);
  let output = u.slice();
  const count = Math.max(1000, Math.min(50000, parseInt(iterations, 10) || APP_CONFIG.PASSWORD_ITERATIONS));
  for (let i = 1; i < count; i++) {
    u = Utilities.computeHmacSha256Signature(u, passwordBytes);
    for (let j = 0; j < output.length; j++) output[j] = (output[j] ^ u[j]);
  }
  return Utilities.base64EncodeWebSafe(output).replace(/=+$/g, '');
}

// =====================================================================================
// 06A. SYSTEM SETTINGS, LOOKUP VALUES AND HOUSEHOLD ASSIGNMENTS
// =====================================================================================

function actionSettingsList_(token, data) {
  requireRole_(token, ['ADMIN']);
  const rows = getRows_('SETTINGS').map(function (row) {
    return {
      setting_key: row.setting_key,
      setting_value: row.setting_value,
      description: row.description,
      updated_at: row.updated_at,
      updated_by: row.updated_by
    };
  });
  if (data.setting_key) return rows.filter(function (row) { return String(row.setting_key) === String(data.setting_key); });
  return rows;
}

function actionSettingsUpdate_(token, data) {
  const actor = requireRole_(token, ['ADMIN']);
  const key = String(data.setting_key || '').trim();
  if (!key || data.setting_value === undefined) throw new Error('INVALID_INPUT');
  const sheet = getSheet_('SETTINGS');
  const rows = getRows_('SETTINGS');
  const target = rows.find(function (row) { return String(row.setting_key) === key; });
  const now = nowIso_();
  if (target) {
    const headers = getHeaders_('SETTINGS');
    const rowNumber = Number(target.__rowNumber);
    const map = { setting_value: data.setting_value, description: data.description === undefined ? target.description : data.description, updated_at: now, updated_by: actor.user_id };
    headers.forEach(function (header, index) {
      if (Object.prototype.hasOwnProperty.call(map, header)) sheet.getRange(rowNumber, index + 1).setValue(safeCellValue_(map[header]));
    });
  } else {
    appendRecord_('SETTINGS', { setting_key: key, setting_value: data.setting_value, description: data.description || '', updated_at: now, updated_by: actor.user_id });
  }
  auditLog_(actor, 'SETTING_UPDATE', 'SETTING', key, 'แก้ไขการตั้งค่าระบบ', '', 'SUCCESS');
  return { setting_key: key, setting_value: data.setting_value };
}

function actionLookupsList_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = getRows_('LOOKUP_VALUES').filter(function (row) { return normalizeBoolean_(row.is_active); });
  if (data.lookup_group) rows = rows.filter(function (row) { return String(row.lookup_group) === String(data.lookup_group); });
  rows.sort(function (a, b) { return String(a.lookup_group).localeCompare(String(b.lookup_group)) || Number(a.sort_order || 0) - Number(b.sort_order || 0); });
  return rows;
}

function actionLookupsSave_(token, data) {
  const actor = requireRole_(token, ['ADMIN']);
  const group = String(data.lookup_group || '').trim();
  const code = String(data.lookup_code || '').trim();
  const label = String(data.lookup_label || '').trim();
  if (!group || !code || !label) throw new Error('INVALID_INPUT');
  const rows = getRows_('LOOKUP_VALUES');
  const existing = rows.find(function (row) { return String(row.lookup_group) === group && String(row.lookup_code) === code; });
  const now = nowIso_();
  if (existing) {
    updateRecordById_('LOOKUP_VALUES', 'lookup_id', existing.lookup_id, {
      lookup_label: label,
      sort_order: data.sort_order === undefined ? existing.sort_order : data.sort_order,
      is_active: data.is_active === undefined ? true : normalizeBoolean_(data.is_active),
      notes: String(data.notes || ''), updated_at: now, updated_by: actor.user_id
    });
    auditLog_(actor, 'LOOKUP_UPDATE', 'LOOKUP', existing.lookup_id, 'แก้ไขตัวเลือกข้อมูล', '', 'SUCCESS');
    return getRecordById_('LOOKUP_VALUES', 'lookup_id', existing.lookup_id);
  }
  const record = {
    lookup_id: generateId_('LKP'), lookup_group: group, lookup_code: code, lookup_label: label,
    sort_order: data.sort_order || 999, is_active: data.is_active === undefined ? true : normalizeBoolean_(data.is_active),
    notes: String(data.notes || ''), created_at: now, created_by: actor.user_id,
    updated_at: now, updated_by: actor.user_id
  };
  appendRecord_('LOOKUP_VALUES', record);
  auditLog_(actor, 'LOOKUP_CREATE', 'LOOKUP', record.lookup_id, 'เพิ่มตัวเลือกข้อมูล', '', 'SUCCESS');
  return record;
}

function actionAssignmentsList_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = filterActive_(getRows_('HOUSEHOLD_ASSIGNMENTS'));
  if (data.household_id) rows = rows.filter(function (row) { return String(row.household_id) === String(data.household_id); });
  if (data.volunteer_id) rows = rows.filter(function (row) { return String(row.volunteer_id) === String(data.volunteer_id); });
  if (data.moo) {
    const householdIds = filterActive_(getRows_('HOUSEHOLDS')).filter(function (row) { return String(row.moo) === String(data.moo); }).map(function (row) { return String(row.household_id); });
    rows = rows.filter(function (row) { return householdIds.indexOf(String(row.household_id)) !== -1; });
  }
  return paginate_(rows, data.page, data.pageSize);
}

// =====================================================================================
// 07. USER AND VILLAGE ADMINISTRATION
// =====================================================================================

function actionUsersList_(token, data) {
  requireRole_(token, ['ADMIN']);
  let users = getRows_('USERS').map(publicUser_);
  if (data.role) users = users.filter(function (u) { return String(u.role) === String(data.role); });
  if (data.query) {
    const q = String(data.query).toLowerCase();
    users = users.filter(function (u) {
      return [u.username, u.full_name, u.phone, u.email].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  return paginate_(users, data.page, data.pageSize);
}

function actionUsersCreate_(token, data) {
  const actor = requireRole_(token, ['ADMIN']);
  const username = String(data.username || '').trim();
  const password = String(data.password || '');
  const role = String(data.role || '').toUpperCase();
  if (!username || password.length < APP_CONFIG.PASSWORD_MIN_LENGTH || APP_CONFIG.ALLOWED_ROLES.indexOf(role) === -1) {
    throw new Error('INVALID_INPUT');
  }
  if (getRows_('USERS').some(function (u) { return String(u.username).toLowerCase() === username.toLowerCase(); })) {
    throw new Error('DUPLICATE_RECORD');
  }
  const salt = createSalt_();
  const now = nowIso_();
  const record = {
    user_id: generateId_('USR'), username: username,
    password_hash: hashPassword_(password, salt, APP_CONFIG.PASSWORD_ITERATIONS),
    password_salt: salt, password_iterations: APP_CONFIG.PASSWORD_ITERATIONS,
    full_name: String(data.full_name || '').trim(), role: role,
    phone: String(data.phone || ''), email: String(data.email || ''),
    assigned_moo: String(data.assigned_moo || ''),
    assigned_households_json: JSON.stringify(data.assigned_households || []),
    is_active: data.is_active === undefined ? true : normalizeBoolean_(data.is_active),
    must_change_password: true, failed_login_count: 0,
    created_at: now, created_by: actor.user_id, updated_at: now, updated_by: actor.user_id,
    notes: String(data.notes || '')
  };
  appendRecord_('USERS', record);
  auditLog_(actor, 'USER_CREATE', 'USER', record.user_id, 'สร้างบัญชีผู้ใช้งาน', '', 'SUCCESS');
  return publicUser_(record);
}

function actionUsersUpdate_(token, data) {
  const actor = requireRole_(token, ['ADMIN']);
  const userId = String(data.user_id || '');
  if (!userId) throw new Error('INVALID_INPUT');
  const current = getRecordById_('USERS', 'user_id', userId);
  const patch = {};
  ['full_name', 'role', 'phone', 'email', 'assigned_moo', 'notes'].forEach(function (key) {
    if (data[key] !== undefined) patch[key] = data[key];
  });
  if (data.assigned_households !== undefined) patch.assigned_households_json = JSON.stringify(data.assigned_households || []);
  if (data.is_active !== undefined) patch.is_active = normalizeBoolean_(data.is_active);
  if (patch.role && APP_CONFIG.ALLOWED_ROLES.indexOf(String(patch.role).toUpperCase()) === -1) throw new Error('INVALID_INPUT');
  if (patch.role) patch.role = String(patch.role).toUpperCase();

  const nextRole = patch.role || String(current.role || '').toUpperCase();
  const nextActive = patch.is_active === undefined ? normalizeBoolean_(current.is_active) : patch.is_active;
  preventRemovingLastActiveAdmin_(current, nextRole, nextActive);

  patch.updated_at = nowIso_();
  patch.updated_by = actor.user_id;
  const updated = updateRecordById_('USERS', 'user_id', userId, patch);
  auditLog_(actor, 'USER_UPDATE', 'USER', userId, 'แก้ไขบัญชีผู้ใช้งาน', '', 'SUCCESS');
  return publicUser_(updated);
}

function actionUsersResetPassword_(token, data) {
  const actor = requireRole_(token, ['ADMIN']);
  const userId = String(data.user_id || '');
  const newPassword = String(data.newPassword || '');
  if (!userId || newPassword.length < APP_CONFIG.PASSWORD_MIN_LENGTH) throw new Error('INVALID_PASSWORD');
  const salt = createSalt_();
  updateRecordById_('USERS', 'user_id', userId, {
    password_hash: hashPassword_(newPassword, salt, APP_CONFIG.PASSWORD_ITERATIONS),
    password_salt: salt, password_iterations: APP_CONFIG.PASSWORD_ITERATIONS,
    must_change_password: true, failed_login_count: 0, locked_until: '',
    updated_at: nowIso_(), updated_by: actor.user_id
  });
  auditLog_(actor, 'USER_PASSWORD_RESET', 'USER', userId, 'รีเซ็ตรหัสผ่านผู้ใช้งาน', '', 'SUCCESS');
  return { reset: true };
}

function actionUsersToggle_(token, data) {
  const actor = requireRole_(token, ['ADMIN']);
  const userId = String(data.user_id || '');
  if (!userId || userId === actor.user_id) throw new Error('INVALID_INPUT');
  const target = getRecordById_('USERS', 'user_id', userId);
  const isActive = !normalizeBoolean_(target.is_active);
  preventRemovingLastActiveAdmin_(target, String(target.role || '').toUpperCase(), isActive);
  updateRecordById_('USERS', 'user_id', userId, {
    is_active: isActive, updated_at: nowIso_(), updated_by: actor.user_id
  });
  auditLog_(actor, 'USER_TOGGLE', 'USER', userId, isActive ? 'เปิดใช้งานบัญชี' : 'ระงับบัญชี', '', 'SUCCESS');
  return { user_id: userId, is_active: isActive };
}

/** Prevent accidental lockout by keeping at least one active ADMIN account. */
function preventRemovingLastActiveAdmin_(currentUser, nextRole, nextActive) {
  const wasActiveAdmin = String(currentUser.role || '').toUpperCase() === 'ADMIN' && normalizeBoolean_(currentUser.is_active);
  const remainsActiveAdmin = String(nextRole || '').toUpperCase() === 'ADMIN' && normalizeBoolean_(nextActive);
  if (!wasActiveAdmin || remainsActiveAdmin) return;

  const anotherActiveAdminExists = getRows_('USERS').some(function (user) {
    return String(user.user_id) !== String(currentUser.user_id) &&
      String(user.role || '').toUpperCase() === 'ADMIN' &&
      normalizeBoolean_(user.is_active);
  });
  if (!anotherActiveAdminExists) throw new Error('LAST_ADMIN_REQUIRED');
}

function actionVillagesList_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = getRows_('VILLAGES').filter(function (row) { return normalizeBoolean_(row.is_active); });
  if (data.moo) rows = rows.filter(function (row) { return String(row.moo) === String(data.moo); });
  return paginate_(rows, data.page, data.pageSize);
}

function actionVillagesCreate_(token, data) {
  const actor = requireRole_(token, ['ADMIN']);
  if (!data.moo || !data.village_name) throw new Error('INVALID_INPUT');
  const record = Object.assign({
    village_id: generateId_('VIL'), is_active: true,
    created_at: nowIso_(), created_by: actor.user_id,
    updated_at: nowIso_(), updated_by: actor.user_id
  }, sanitizeFields_('VILLAGES', data, false));
  appendRecord_('VILLAGES', record);
  auditLog_(actor, 'VILLAGE_CREATE', 'VILLAGE', record.village_id, 'เพิ่มข้อมูลหมู่บ้าน', '', 'SUCCESS');
  return record;
}

function actionVillagesUpdate_(token, data) {
  const actor = requireRole_(token, ['ADMIN']);
  const id = String(data.village_id || '');
  if (!id) throw new Error('INVALID_INPUT');
  const patch = sanitizeFields_('VILLAGES', data, false);
  delete patch.village_id;
  patch.updated_at = nowIso_(); patch.updated_by = actor.user_id;
  const updated = updateRecordById_('VILLAGES', 'village_id', id, patch);
  auditLog_(actor, 'VILLAGE_UPDATE', 'VILLAGE', id, 'แก้ไขข้อมูลหมู่บ้าน', '', 'SUCCESS');
  return updated;
}

// =====================================================================================
// 08. HOUSEHOLD MANAGEMENT
// =====================================================================================

function actionHouseholdsList_(token, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = filterActive_(getRows_('HOUSEHOLDS'));
  if (data.moo) rows = rows.filter(function (row) { return String(row.moo) === String(data.moo); });
  if (data.risk_level) rows = rows.filter(function (row) { return String(row.risk_level) === String(data.risk_level); });
  if (data.household_status) rows = rows.filter(function (row) { return String(row.household_status) === String(data.household_status); });
  if (data.volunteer_id) rows = rows.filter(function (row) { return String(row.responsible_volunteer_id) === String(data.volunteer_id); });
  if (data.query) {
    const q = String(data.query).toLowerCase();
    rows = rows.filter(function (row) {
      return [row.household_code, row.house_number, row.household_head_name, row.moo, row.subdistrict].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  rows.sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
  auditLog_(actor, 'HOUSEHOLD_LIST', 'HOUSEHOLD', '', 'เรียกดูรายการครัวเรือน', '', 'SUCCESS');
  return paginate_(rows, data.page, data.pageSize);
}

function actionHouseholdsGet_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  const id = String(data.household_id || '');
  if (!id) throw new Error('INVALID_INPUT');
  const household = getRecordById_('HOUSEHOLDS', 'household_id', id);
  if (String(household.record_status) === APP_CONFIG.DELETED_RECORD_STATUS) throw new Error('NOT_FOUND');
  return household;
}

function actionHouseholdDossier_(token, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  const householdId = String(data.household_id || '');
  if (!householdId) throw new Error('INVALID_INPUT');
  const household = getRecordById_('HOUSEHOLDS', 'household_id', householdId);
  if (String(household.record_status) === APP_CONFIG.DELETED_RECORD_STATUS) throw new Error('NOT_FOUND');
  const members = filterActive_(getRows_('FAMILY_MEMBERS')).filter(function (row) { return String(row.household_id) === householdId; });
  const memberIds = members.map(function (row) { return String(row.member_id); });
  const relations = filterActive_(getRows_('FAMILY_RELATIONS')).filter(function (row) {
    return String(row.household_id) === householdId || memberIds.indexOf(String(row.member_id)) !== -1;
  });
  const screenings = filterActive_(getRows_('HEALTH_SCREENING')).filter(function (row) { return String(row.household_id) === householdId; });
  const chronic = filterActive_(getRows_('CHRONIC_DISEASE')).filter(function (row) { return String(row.household_id) === householdId; });
  const risks = filterActive_(getRows_('HEALTH_RISK')).filter(function (row) { return String(row.household_id) === householdId; });
  const vaccinations = filterActive_(getRows_('VACCINATIONS')).filter(function (row) { return String(row.household_id) === householdId; });
  const visits = filterActive_(getRows_('HOME_VISITS')).filter(function (row) { return String(row.household_id) === householdId; });
  const appointments = filterActive_(getRows_('APPOINTMENTS')).filter(function (row) { return String(row.household_id) === householdId; });
  auditLog_(actor, 'HOUSEHOLD_DOSSIER_VIEW', 'HOUSEHOLD', householdId, 'เปิดแฟ้มครอบครัว', '', 'SUCCESS');
  return {
    household: household,
    members: members,
    relations: relations,
    healthScreenings: screenings,
    chronicDiseases: chronic,
    healthRisks: risks,
    vaccinations: vaccinations,
    homeVisits: visits,
    appointments: appointments
  };
}

// =====================================================================================
// 09. FAMILY MEMBER MANAGEMENT
// =====================================================================================

function actionMembersList_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = filterActive_(getRows_('FAMILY_MEMBERS'));
  if (data.household_id) rows = rows.filter(function (row) { return String(row.household_id) === String(data.household_id); });
  if (data.gender) rows = rows.filter(function (row) { return String(row.gender) === String(data.gender); });
  if (data.living_status) rows = rows.filter(function (row) { return String(row.living_status) === String(data.living_status); });
  if (data.min_age !== undefined && data.min_age !== '') rows = rows.filter(function (row) { return Number(row.age) >= Number(data.min_age); });
  if (data.max_age !== undefined && data.max_age !== '') rows = rows.filter(function (row) { return Number(row.age) <= Number(data.max_age); });
  if (data.query) {
    const q = String(data.query).toLowerCase().replace(/\s+/g, ' ').trim();
    rows = rows.filter(function (row) {
      return [row.national_id, row.first_name, row.last_name, row.nickname, row.phone].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  return paginate_(rows, data.page, data.pageSize);
}

function actionMembersGet_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  const id = String(data.member_id || '');
  if (!id) throw new Error('INVALID_INPUT');
  const member = getRecordById_('FAMILY_MEMBERS', 'member_id', id);
  if (String(member.record_status) === APP_CONFIG.DELETED_RECORD_STATUS) throw new Error('NOT_FOUND');
  return member;
}

function actionMemberMove_(token, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  const memberId = String(data.member_id || '');
  const newHouseholdId = String(data.new_household_id || '');
  if (!memberId || !newHouseholdId) throw new Error('INVALID_INPUT');
  getRecordById_('HOUSEHOLDS', 'household_id', newHouseholdId);
  const oldMember = getRecordById_('FAMILY_MEMBERS', 'member_id', memberId);
  const updated = updateRecordById_('FAMILY_MEMBERS', 'member_id', memberId, {
    household_id: newHouseholdId,
    move_out_date: data.move_date || nowIso_().substring(0, 10),
    move_in_date: data.move_date || nowIso_().substring(0, 10),
    updated_at: nowIso_(), updated_by: actor.user_id
  });
  recalculateHouseholdMemberCount_(String(oldMember.household_id));
  recalculateHouseholdMemberCount_(newHouseholdId);
  auditLog_(actor, 'MEMBER_MOVE', 'FAMILY_MEMBER', memberId, 'ย้ายสมาชิกไปยังครัวเรือนใหม่', '', 'SUCCESS');
  return updated;
}

function recalculateHouseholdMemberCount_(householdId) {
  const count = filterActive_(getRows_('FAMILY_MEMBERS')).filter(function (row) {
    return String(row.household_id) === String(householdId) && String(row.living_status || 'ALIVE') !== 'MOVED_OUT';
  }).length;
  updateRecordById_('HOUSEHOLDS', 'household_id', householdId, { member_count: count, updated_at: nowIso_(), updated_by: 'SYSTEM' });
}

// =====================================================================================
// 10. GENOGRAM / FAMILY RELATIONSHIPS
// =====================================================================================

function actionRelationsList_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = filterActive_(getRows_('FAMILY_RELATIONS'));
  if (data.household_id) rows = rows.filter(function (row) { return String(row.household_id) === String(data.household_id); });
  if (data.member_id) rows = rows.filter(function (row) {
    return String(row.member_id) === String(data.member_id) || String(row.related_member_id) === String(data.member_id);
  });
  return paginate_(rows, data.page, data.pageSize);
}

// =====================================================================================
// 11. HEALTH SCREENING, CHRONIC DISEASE, RISKS AND VACCINATION
// =====================================================================================

function actionHealthList_(token, sheetName, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = filterActive_(getRows_(sheetName));
  if (data.member_id) rows = rows.filter(function (row) { return String(row.member_id) === String(data.member_id); });
  if (data.household_id) rows = rows.filter(function (row) { return String(row.household_id) === String(data.household_id); });
  if (data.disease_code) rows = rows.filter(function (row) { return String(row.disease_code) === String(data.disease_code); });
  if (data.from_date) {
    const dateField = sheetName === 'CHRONIC_DISEASE' ? 'diagnosis_date' : (sheetName === 'VACCINATIONS' ? 'vaccination_date' : (sheetName === 'HEALTH_SCREENING' ? 'screening_date' : 'assessment_date'));
    rows = rows.filter(function (row) { return String(row[dateField] || '') >= String(data.from_date); });
  }
  if (data.to_date) {
    const dateField2 = sheetName === 'CHRONIC_DISEASE' ? 'diagnosis_date' : (sheetName === 'VACCINATIONS' ? 'vaccination_date' : (sheetName === 'HEALTH_SCREENING' ? 'screening_date' : 'assessment_date'));
    rows = rows.filter(function (row) { return String(row[dateField2] || '') <= String(data.to_date); });
  }
  rows.sort(function (a, b) {
    return String(b.screening_date || b.diagnosis_date || b.assessment_date || b.vaccination_date || '').localeCompare(
      String(a.screening_date || a.diagnosis_date || a.assessment_date || a.vaccination_date || '')
    );
  });
  return paginate_(rows, data.page, data.pageSize);
}

// =====================================================================================
// 12. HOME VISITS AND APPOINTMENTS
// =====================================================================================

function actionVisitsList_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = filterActive_(getRows_('HOME_VISITS'));
  if (data.household_id) rows = rows.filter(function (row) { return String(row.household_id) === String(data.household_id); });
  if (data.member_id) rows = rows.filter(function (row) { return String(row.member_id) === String(data.member_id); });
  if (data.volunteer_id) rows = rows.filter(function (row) { return String(row.volunteer_id) === String(data.volunteer_id); });
  if (data.from_date) rows = rows.filter(function (row) { return String(row.visit_date || '') >= String(data.from_date); });
  if (data.to_date) rows = rows.filter(function (row) { return String(row.visit_date || '') <= String(data.to_date); });
  rows.sort(function (a, b) { return String(b.visit_date || '').localeCompare(String(a.visit_date || '')); });
  return paginate_(rows, data.page, data.pageSize);
}

function actionAppointmentsList_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = filterActive_(getRows_('APPOINTMENTS'));
  if (data.member_id) rows = rows.filter(function (row) { return String(row.member_id) === String(data.member_id); });
  if (data.household_id) rows = rows.filter(function (row) { return String(row.household_id) === String(data.household_id); });
  if (data.appointment_status) rows = rows.filter(function (row) { return String(row.appointment_status) === String(data.appointment_status); });
  if (data.from_date) rows = rows.filter(function (row) { return String(row.appointment_date || '') >= String(data.from_date); });
  if (data.to_date) rows = rows.filter(function (row) { return String(row.appointment_date || '') <= String(data.to_date); });
  rows.sort(function (a, b) { return String(a.appointment_date || '').localeCompare(String(b.appointment_date || '')); });
  return paginate_(rows, data.page, data.pageSize);
}

// =====================================================================================
// 13. GENERIC CREATE / UPDATE / ARCHIVE FOR STAFF
// =====================================================================================

function actionEntityCreate_(token, sheetName, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  const idField = TABLE_ID_FIELDS[sheetName];
  if (!idField) throw new Error('INVALID_INPUT');
  validateEntityInput_(sheetName, data, true);
  const record = sanitizeFields_(sheetName, data, true);
  const now = nowIso_();
  record[idField] = generateId_(sheetName.substring(0, 3));
  record.created_at = now;
  record.created_by = actor.user_id;
  record.updated_at = now;
  record.updated_by = actor.user_id;
  record.record_status = APP_CONFIG.ACTIVE_RECORD_STATUS;
  if (sheetName === 'FAMILY_MEMBERS') {
    record.age = calculateAge_(record.date_of_birth);
    if (record.national_id) {
      validateNationalId_(String(record.national_id));
      validateMemberNationalIdUnique_(String(record.national_id), '');
    }
    ensureHouseholdExists_(record.household_id);
  }
  if (sheetName === 'HOUSEHOLDS') {
    validateHouseholdUniqueness_(record, '');
    if (!record.household_code) record.household_code = 'WK-' + record.household_id.replace(/[^A-Z0-9]/g, '').slice(-12);
    if (!record.household_status) record.household_status = 'NORMAL';
    if (!record.risk_level) record.risk_level = 'LOW';
    if (record.member_count === undefined || record.member_count === '') record.member_count = 0;
  }
  if (sheetName === 'FAMILY_RELATIONS') {
    ensureMemberExists_(record.member_id);
    ensureMemberExists_(record.related_member_id);
    if (record.household_id) ensureHouseholdExists_(record.household_id);
  }
  if (sheetName !== 'HOUSEHOLDS' && record.member_id && sheetName !== 'FAMILY_MEMBERS') {
    ensureMemberExists_(record.member_id);
    if (!record.household_id) {
      const linkedMember = getRecordById_('FAMILY_MEMBERS', 'member_id', record.member_id);
      record.household_id = linkedMember.household_id;
    }
  }
  if (record.household_id && sheetName !== 'HOUSEHOLDS') ensureHouseholdExists_(record.household_id);
  if (sheetName === 'HOUSEHOLD_ASSIGNMENTS') {
    ensureHouseholdExists_(record.household_id);
    const assignedUser = getRecordById_('USERS', 'user_id', record.volunteer_id);
    if (String(assignedUser.role) !== 'VOLUNTEER') throw new Error('INVALID_INPUT');
  }
  appendRecord_(sheetName, record);
  if (sheetName === 'FAMILY_MEMBERS' && record.household_id) recalculateHouseholdMemberCount_(record.household_id);
  if (sheetName === 'HOME_VISITS' && record.household_id) {
    updateRecordById_('HOUSEHOLDS', 'household_id', record.household_id, {
      last_home_visit_date: record.visit_date || now.substring(0, 10),
      next_followup_date: record.followup_date || '',
      updated_at: now, updated_by: actor.user_id
    });
  }
  auditLog_(actor, sheetName + '_CREATE', sheetName, record[idField], 'เพิ่มข้อมูล ' + sheetName, '', 'SUCCESS');
  return record;
}

function actionEntityUpdate_(token, sheetName, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  const idField = TABLE_ID_FIELDS[sheetName];
  const id = String(data[idField] || '');
  if (!id) throw new Error('INVALID_INPUT');
  const existing = getRecordById_(sheetName, idField, id);
  if (String(existing.record_status) === APP_CONFIG.DELETED_RECORD_STATUS) throw new Error('NOT_FOUND');
  validateEntityInput_(sheetName, data, false);
  const patch = sanitizeFields_(sheetName, data, false);
  delete patch[idField];
  if (sheetName === 'FAMILY_MEMBERS') {
    if (patch.date_of_birth) patch.age = calculateAge_(patch.date_of_birth);
    if (patch.national_id) {
      validateNationalId_(String(patch.national_id));
      validateMemberNationalIdUnique_(String(patch.national_id), id);
    }
    if (patch.household_id) ensureHouseholdExists_(patch.household_id);
  }
  if (sheetName === 'FAMILY_RELATIONS') {
    if (patch.member_id) ensureMemberExists_(patch.member_id);
    if (patch.related_member_id) ensureMemberExists_(patch.related_member_id);
  }
  if (sheetName === 'HOUSEHOLD_ASSIGNMENTS') {
    if (patch.household_id) ensureHouseholdExists_(patch.household_id);
    if (patch.volunteer_id) {
      const assignedUser = getRecordById_('USERS', 'user_id', patch.volunteer_id);
      if (String(assignedUser.role) !== 'VOLUNTEER') throw new Error('INVALID_INPUT');
    }
  }
  if (sheetName === 'HOUSEHOLDS') validateHouseholdUniqueness_(Object.assign({}, existing, patch), id);
  patch.updated_at = nowIso_();
  patch.updated_by = actor.user_id;
  const updated = updateRecordById_(sheetName, idField, id, patch);
  if (sheetName === 'FAMILY_MEMBERS') {
    recalculateHouseholdMemberCount_(String(existing.household_id));
    if (patch.household_id && String(patch.household_id) !== String(existing.household_id)) recalculateHouseholdMemberCount_(String(patch.household_id));
  }
  auditLog_(actor, sheetName + '_UPDATE', sheetName, id, 'แก้ไขข้อมูล ' + sheetName, '', 'SUCCESS');
  return updated;
}

function actionEntityArchive_(token, sheetName, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  const idField = TABLE_ID_FIELDS[sheetName];
  const id = String(data[idField] || '');
  if (!id) throw new Error('INVALID_INPUT');
  const current = getRecordById_(sheetName, idField, id);
  const updated = updateRecordById_(sheetName, idField, id, {
    record_status: APP_CONFIG.DELETED_RECORD_STATUS,
    updated_at: nowIso_(), updated_by: actor.user_id
  });
  auditLog_(actor, sheetName + '_ARCHIVE', sheetName, id, 'ยกเลิกรายการข้อมูล', '', 'SUCCESS');
  if (sheetName === 'FAMILY_MEMBERS' && current.household_id) recalculateHouseholdMemberCount_(String(current.household_id));
  return { archived: true, record: updated };
}

function validateEntityInput_(sheetName, data, isCreate) {
  if (!data || typeof data !== 'object') throw new Error('INVALID_INPUT');
  if (sheetName === 'HOUSEHOLDS') {
    if (isCreate && (!data.house_number || !data.moo)) throw new Error('INVALID_INPUT');
  }
  if (sheetName === 'FAMILY_MEMBERS') {
    if (isCreate && (!data.household_id || !data.first_name || !data.last_name)) throw new Error('INVALID_INPUT');
    if (data.national_id) validateNationalId_(String(data.national_id));
  }
  if (sheetName === 'FAMILY_RELATIONS') {
    if (isCreate && (!data.member_id || !data.related_member_id || !data.relation_type)) throw new Error('INVALID_INPUT');
    if (data.member_id && data.related_member_id && String(data.member_id) === String(data.related_member_id)) throw new Error('INVALID_INPUT');
  }
  if (['HEALTH_SCREENING', 'CHRONIC_DISEASE', 'HEALTH_RISK', 'VACCINATIONS'].indexOf(sheetName) !== -1) {
    if (isCreate && !data.member_id) throw new Error('INVALID_INPUT');
  }
  if (sheetName === 'HOME_VISITS' && isCreate && !data.household_id) throw new Error('INVALID_INPUT');
  if (sheetName === 'APPOINTMENTS' && isCreate && !data.member_id) throw new Error('INVALID_INPUT');
  if (sheetName === 'HOUSEHOLD_ASSIGNMENTS' && isCreate && (!data.household_id || !data.volunteer_id)) throw new Error('INVALID_INPUT');
}

function validateHouseholdUniqueness_(record, ignoreId) {
  const duplicate = filterActive_(getRows_('HOUSEHOLDS')).some(function (row) {
    if (ignoreId && String(row.household_id) === String(ignoreId)) return false;
    return String(row.house_number || '').trim() === String(record.house_number || '').trim() &&
      String(row.moo || '').trim() === String(record.moo || '').trim() &&
      String(row.subdistrict || '').trim() === String(record.subdistrict || '').trim();
  });
  if (duplicate) throw new Error('DUPLICATE_RECORD');
}

function validateNationalId_(nationalId) {
  const id = String(nationalId || '').replace(/\D/g, '');
  if (!/^\d{13}$/.test(id)) throw new Error('INVALID_NATIONAL_ID');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id.charAt(i)) * (13 - i);
  const check = (11 - (sum % 11)) % 10;
  if (check !== Number(id.charAt(12))) throw new Error('INVALID_NATIONAL_ID');
}

function validateMemberNationalIdUnique_(nationalId, ignoreMemberId) {
  const duplicate = filterActive_(getRows_('FAMILY_MEMBERS')).some(function (member) {
    if (ignoreMemberId && String(member.member_id) === String(ignoreMemberId)) return false;
    return String(member.national_id || '').replace(/\D/g, '') === String(nationalId).replace(/\D/g, '');
  });
  if (duplicate) throw new Error('DUPLICATE_RECORD');
}

function calculateAge_(dateOfBirth) {
  if (!dateOfBirth) return '';
  const dob = new Date(dateOfBirth);
  if (isNaN(dob.getTime())) return '';
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
  return age >= 0 ? age : '';
}

function ensureHouseholdExists_(householdId) {
  if (!householdId) throw new Error('INVALID_INPUT');
  const item = getRecordById_('HOUSEHOLDS', 'household_id', String(householdId));
  if (String(item.record_status) === APP_CONFIG.DELETED_RECORD_STATUS) throw new Error('NOT_FOUND');
}

function ensureMemberExists_(memberId) {
  const item = getRecordById_('FAMILY_MEMBERS', 'member_id', String(memberId));
  if (String(item.record_status) === APP_CONFIG.DELETED_RECORD_STATUS) throw new Error('NOT_FOUND');
}

// =====================================================================================
// 14. VOLUNTEER SUBMISSION WORKFLOW (CREATE-ONLY, NO DATA SEARCH OR READ)
// =====================================================================================

function actionVolunteerSubmit_(token, data) {
  const actor = requireRole_(token, ['VOLUNTEER']);
  const entityType = String(data.entity_type || '').toUpperCase();
  const allowed = ['HOUSEHOLDS', 'FAMILY_MEMBERS', 'HEALTH_SCREENING', 'CHRONIC_DISEASE', 'HEALTH_RISK', 'VACCINATIONS', 'HOME_VISITS'];
  if (allowed.indexOf(entityType) === -1) throw new Error('VOLUNTEER_CREATE_ONLY');
  if (String(data.action_type || 'CREATE').toUpperCase() !== 'CREATE') throw new Error('VOLUNTEER_CREATE_ONLY');
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
  const clientTempId = String(data.client_temp_id || payload.client_temp_id || '');
  const parentTempId = String(data.parent_client_temp_id || payload.parent_client_temp_id || payload.household_client_temp_id || '');
  if (clientTempId && getRows_('APPROVAL_QUEUE').some(function (row) {
    return String(row.submitted_by) === String(actor.user_id) && String(row.client_temp_id) === clientTempId;
  })) throw new Error('DUPLICATE_RECORD');

  if (actor.assigned_moo && !payload.moo && entityType === 'HOUSEHOLDS') payload.moo = actor.assigned_moo;
  validateVolunteerPayload_(entityType, payload);

  // Resolve references inside the server without returning existing household/member data.
  // The same references are resolved again during approval to prevent village-boundary bypass.
  resolveVolunteerParentReference_(payload, { parent_client_temp_id: parentTempId, submitted_by: actor.user_id });
  if (actor.assigned_moo && payload.moo && String(actor.assigned_moo) !== String(payload.moo)) {
    throw new Error('PERMISSION_DENIED');
  }

  const submissionId = generateId_('SUB');
  const now = nowIso_();
  appendRecord_('APPROVAL_QUEUE', {
    submission_id: submissionId,
    client_temp_id: clientTempId,
    submitted_by: actor.user_id,
    submitter_name: actor.full_name,
    submitter_role: actor.role,
    entity_type: entityType,
    entity_id: '',
    action_type: 'CREATE',
    payload_json: JSON.stringify(payload),
    attachments_json: JSON.stringify(data.attachments || []),
    submission_status: 'PENDING',
    reviewed_by: '', reviewer_name: '', reviewed_at: '', review_note: '',
    resolved_entity_id: '', parent_client_temp_id: parentTempId,
    created_at: now, updated_at: now
  });
  notifyRole_(['ADMIN', 'OFFICER'], 'มีข้อมูลใหม่จาก อสม.', 'มีรายการใหม่รอตรวจสอบจาก ' + String(actor.full_name || actor.username), 'APPROVAL', 'APPROVAL', submissionId);
  auditLog_(actor, 'VOLUNTEER_SUBMIT', entityType, submissionId, 'ส่งข้อมูลใหม่เพื่อรอตรวจสอบ', '', 'SUCCESS');
  return { submission_id: submissionId, submission_status: 'PENDING', submitted_at: now };
}

function validateVolunteerPayload_(entityType, payload) {
  if (entityType === 'HOUSEHOLDS' && (!payload.house_number || !payload.moo)) throw new Error('INVALID_INPUT');
  if (entityType === 'FAMILY_MEMBERS' && (!payload.first_name || !payload.last_name)) throw new Error('INVALID_INPUT');
  if (entityType === 'HOME_VISITS' && !payload.household_id && !payload.household_client_temp_id && !payload.household_code && !payload.member_id) throw new Error('INVALID_INPUT');
  if (payload.national_id) validateNationalId_(String(payload.national_id));
}

function actionVolunteerMySubmissions_(token, data) {
  const actor = requireRole_(token, ['VOLUNTEER']);
  let rows = getRows_('APPROVAL_QUEUE').filter(function (row) { return String(row.submitted_by) === String(actor.user_id); });
  rows = rows.map(function (row) {
    return {
      submission_id: row.submission_id,
      entity_type: row.entity_type,
      action_type: row.action_type,
      submission_status: row.submission_status,
      review_note: row.review_note,
      created_at: row.created_at,
      reviewed_at: row.reviewed_at
    };
  });
  rows.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  return paginate_(rows, data.page, data.pageSize);
}

function actionApprovalsList_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  let rows = getRows_('APPROVAL_QUEUE');
  if (data.submission_status) rows = rows.filter(function (row) { return String(row.submission_status) === String(data.submission_status); });
  if (data.entity_type) rows = rows.filter(function (row) { return String(row.entity_type) === String(data.entity_type); });
  rows.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  return paginate_(rows, data.page, data.pageSize);
}

function actionApprovalReview_(token, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  const submissionId = String(data.submission_id || '');
  const decision = String(data.decision || '').toUpperCase();
  if (!submissionId || ['APPROVE', 'REJECT', 'RETURN'].indexOf(decision) === -1) throw new Error('INVALID_REVIEW_STATUS');
  const submission = getRecordById_('APPROVAL_QUEUE', 'submission_id', submissionId);
  if (String(submission.submission_status) !== 'PENDING') throw new Error('INVALID_REVIEW_STATUS');

  if (decision === 'APPROVE') {
    const entityType = String(submission.entity_type);
    const sheetName = ENTITY_TABLE_MAP[entityType];
    if (!sheetName || ['FAMILY_RELATIONS', 'APPOINTMENTS'].indexOf(sheetName) !== -1) throw new Error('INVALID_INPUT');
    const payload = parseJsonField_(submission.payload_json, {});
    resolveVolunteerParentReference_(payload, submission);
    const submitter = getRows_('USERS').find(function (u) { return String(u.user_id) === String(submission.submitted_by); });
    if (submitter && submitter.assigned_moo && payload.moo && String(submitter.assigned_moo) !== String(payload.moo)) throw new Error('PERMISSION_DENIED');
    if (submitter && submitter.assigned_moo && payload.household_id) {
      const assignedHousehold = getRecordById_('HOUSEHOLDS', 'household_id', payload.household_id);
      if (String(submitter.assigned_moo) !== String(assignedHousehold.moo)) throw new Error('PERMISSION_DENIED');
    }
    validateEntityInput_(sheetName, payload, true);
    const idField = TABLE_ID_FIELDS[sheetName];
    const record = sanitizeFields_(sheetName, payload, true);
    const now = nowIso_();
    record[idField] = generateId_(sheetName.substring(0, 3));
    record.created_at = now; record.created_by = submission.submitted_by;
    record.updated_at = now; record.updated_by = actor.user_id;
    record.record_status = APP_CONFIG.ACTIVE_RECORD_STATUS;
    if (submitter) {
      if (sheetName === 'HOUSEHOLDS' && !record.responsible_volunteer_id) {
        record.responsible_volunteer_id = submitter.user_id;
        record.responsible_volunteer_name = submitter.full_name;
      }
      if (sheetName === 'HOME_VISITS' && !record.volunteer_id) {
        record.volunteer_id = submitter.user_id;
        record.volunteer_name = submitter.full_name;
      }
    }
    if (sheetName === 'FAMILY_MEMBERS') {
      record.age = calculateAge_(record.date_of_birth);
      if (record.national_id) {
        validateNationalId_(String(record.national_id));
        validateMemberNationalIdUnique_(String(record.national_id), '');
      }
      ensureHouseholdExists_(record.household_id);
    }
    if (sheetName === 'HOUSEHOLDS') {
      validateHouseholdUniqueness_(record, '');
      if (!record.household_code) record.household_code = 'WK-' + record[idField].replace(/[^A-Z0-9]/g, '').slice(-12);
      if (!record.household_status) record.household_status = 'NORMAL';
      if (!record.risk_level) record.risk_level = 'LOW';
      if (record.member_count === undefined || record.member_count === '') record.member_count = 0;
    }
    if (record.member_id && sheetName !== 'FAMILY_MEMBERS') {
      ensureMemberExists_(record.member_id);
      if (!record.household_id) {
        const linkedMember = getRecordById_('FAMILY_MEMBERS', 'member_id', record.member_id);
        record.household_id = linkedMember.household_id;
      }
    }
    if (record.household_id && sheetName !== 'HOUSEHOLDS') ensureHouseholdExists_(record.household_id);
    appendRecord_(sheetName, record);
    if (sheetName === 'FAMILY_MEMBERS' && record.household_id) recalculateHouseholdMemberCount_(record.household_id);
    updateRecordById_('APPROVAL_QUEUE', 'submission_id', submissionId, {
      submission_status: 'APPROVED', reviewed_by: actor.user_id, reviewer_name: actor.full_name,
      reviewed_at: now, review_note: String(data.review_note || ''), resolved_entity_id: record[idField],
      entity_id: record[idField], updated_at: now
    });
    auditLog_(actor, 'APPROVAL_APPROVE', entityType, record[idField], 'อนุมัติข้อมูลจาก อสม.', '', 'SUCCESS');
    notifyUser_(submission.submitted_by, 'ข้อมูลได้รับการอนุมัติ', 'ข้อมูลที่คุณส่งได้รับการตรวจสอบและอนุมัติแล้ว', 'APPROVAL', entityType, record[idField]);
    return { decision: 'APPROVED', entity_id: record[idField] };
  }

  const status = decision === 'REJECT' ? 'REJECTED' : 'RETURNED';
  updateRecordById_('APPROVAL_QUEUE', 'submission_id', submissionId, {
    submission_status: status, reviewed_by: actor.user_id, reviewer_name: actor.full_name,
    reviewed_at: nowIso_(), review_note: String(data.review_note || ''), updated_at: nowIso_()
  });
  auditLog_(actor, 'APPROVAL_' + status, submission.entity_type, submissionId, 'ส่งผลการตรวจสอบข้อมูลจาก อสม.', '', 'SUCCESS');
  notifyUser_(submission.submitted_by, status === 'REJECTED' ? 'ข้อมูลไม่ผ่านการอนุมัติ' : 'ข้อมูลถูกส่งกลับให้ตรวจสอบ', String(data.review_note || 'กรุณาติดต่อเจ้าหน้าที่'), 'APPROVAL', submission.entity_type, submissionId);
  return { decision: status };
}

function resolveVolunteerParentReference_(payload, submission) {
  if (!payload.household_id) {
    const parentTempId = String((submission && submission.parent_client_temp_id) || payload.household_client_temp_id || '');
    if (parentTempId) {
      const approved = getRows_('APPROVAL_QUEUE').find(function (row) {
        return String(row.client_temp_id) === parentTempId &&
          (!submission || !submission.submitted_by || String(row.submitted_by) === String(submission.submitted_by)) &&
          String(row.submission_status) === 'APPROVED' && String(row.entity_type) === 'HOUSEHOLDS' && row.resolved_entity_id;
      });
      if (!approved) throw new Error('NOT_FOUND');
      payload.household_id = String(approved.resolved_entity_id);
    } else if (payload.household_code) {
      const householdByCode = filterActive_(getRows_('HOUSEHOLDS')).find(function (row) {
        return String(row.household_code || '').toLowerCase() === String(payload.household_code).toLowerCase();
      });
      if (!householdByCode) throw new Error('NOT_FOUND');
      payload.household_id = String(householdByCode.household_id);
    } else if (payload.member_id) {
      const member = getRecordById_('FAMILY_MEMBERS', 'member_id', String(payload.member_id));
      payload.household_id = String(member.household_id || '');
    }
  }

  // Derive the village from the actual household record, never trust a client-supplied moo.
  if (payload.household_id) {
    const household = getRecordById_('HOUSEHOLDS', 'household_id', String(payload.household_id));
    if (String(household.record_status || '') === APP_CONFIG.DELETED_RECORD_STATUS) throw new Error('NOT_FOUND');
    if (payload.moo && String(payload.moo) !== String(household.moo)) throw new Error('PERMISSION_DENIED');
    payload.moo = String(household.moo || '');
  }
}

// =====================================================================================
// 15. GLOBAL SEARCH, DASHBOARD SUMMARY AND REPORT DATA
// =====================================================================================

function actionGlobalSearch_(token, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  const query = String(data.query || '').trim().toLowerCase();
  if (query.length < 2) return { households: [], members: [] };
  const households = filterActive_(getRows_('HOUSEHOLDS')).filter(function (row) {
    return [row.household_code, row.house_number, row.household_head_name, row.moo].join(' ').toLowerCase().indexOf(query) !== -1;
  }).slice(0, APP_CONFIG.MAX_SEARCH_RESULTS).map(function (row) {
    return {
      household_id: row.household_id,
      household_code: row.household_code,
      house_number: row.house_number,
      moo: row.moo,
      household_head_name: row.household_head_name,
      subdistrict: row.subdistrict,
      district: row.district,
      risk_level: row.risk_level
    };
  });
  const members = filterActive_(getRows_('FAMILY_MEMBERS')).filter(function (row) {
    return [row.national_id, row.first_name, row.last_name, row.nickname, row.phone].join(' ').toLowerCase().indexOf(query) !== -1;
  }).slice(0, APP_CONFIG.MAX_SEARCH_RESULTS).map(function (row) {
    return {
      member_id: row.member_id,
      household_id: row.household_id,
      national_id: row.national_id,
      first_name: row.first_name,
      last_name: row.last_name,
      gender: row.gender,
      age: row.age,
      phone: row.phone
    };
  });
  auditLog_(actor, 'GLOBAL_SEARCH', 'SYSTEM', '', 'ค้นหาข้อมูลประชาชน', '', 'SUCCESS');
  return { households: households, members: members };
}

function actionDashboardStats_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  const households = filterActive_(getRows_('HOUSEHOLDS'));
  const members = filterActive_(getRows_('FAMILY_MEMBERS'));
  const chronic = filterActive_(getRows_('CHRONIC_DISEASE'));
  const visits = filterActive_(getRows_('HOME_VISITS'));
  const submissions = getRows_('APPROVAL_QUEUE');
  const users = getRows_('USERS').filter(function (row) { return normalizeBoolean_(row.is_active); });
  const mooFilter = data.moo ? String(data.moo) : '';
  const householdIds = households.filter(function (h) { return !mooFilter || String(h.moo) === mooFilter; }).map(function (h) { return String(h.household_id); });
  const filteredMembers = members.filter(function (m) { return householdIds.indexOf(String(m.household_id)) !== -1; });
  const memberIds = filteredMembers.map(function (m) { return String(m.member_id); });
  const diseaseRows = chronic.filter(function (d) { return memberIds.indexOf(String(d.member_id)) !== -1; });
  const isDisease = function (code, name) {
    return diseaseRows.filter(function (row) {
      return String(row.disease_code).toUpperCase() === code || String(row.disease_name).toLowerCase().indexOf(name) !== -1;
    }).length;
  };
  const memberAge = function (member) {
    const age = member.age !== '' && member.age !== null && member.age !== undefined ? Number(member.age) : Number(calculateAge_(member.date_of_birth));
    return isFinite(age) && age >= 0 ? age : null;
  };
  const ageCount = function (minAge) {
    return filteredMembers.filter(function (m) { const age = memberAge(m); return age !== null && age >= minAge; }).length;
  };
  const genderCount = function (gender) { return filteredMembers.filter(function (m) { return String(m.gender).toUpperCase() === gender; }).length; };
  const pending = submissions.filter(function (s) { return String(s.submission_status) === 'PENDING'; }).length;
  const activeVolunteers = users.filter(function (u) { return String(u.role) === 'VOLUNTEER'; }).length;
  const activeOfficers = users.filter(function (u) { return String(u.role) === 'OFFICER'; }).length;
  const bedBound = filteredMembers.filter(function (m) { return ['BEDRIDDEN', 'BED_BOUND', 'ติดเตียง'].indexOf(String(m.care_level || '').toUpperCase()) !== -1; }).length;
  const homeBound = filteredMembers.filter(function (m) { return ['HOMEBOUND', 'HOME_BOUND', 'ติดบ้าน'].indexOf(String(m.care_level || '').toUpperCase()) !== -1; }).length;
  const disability = filteredMembers.filter(function (m) { return normalizeBoolean_(m.disability_status); }).length;
  const olderAdults = ageCount(60);
  const visitThisMonth = visits.filter(function (v) { return String(v.visit_date || '').substring(0, 7) === nowIso_().substring(0, 7); }).length;
  const riskHouseholds = households.filter(function (h) {
    return (!mooFilter || String(h.moo) === mooFilter) && String(h.risk_level).toUpperCase() === 'HIGH';
  }).length;

  return {
    totals: {
      households: households.filter(function (h) { return !mooFilter || String(h.moo) === mooFilter; }).length,
      population: filteredMembers.length,
      male: genderCount('MALE'), female: genderCount('FEMALE'),
      olderAdults: olderAdults, disability: disability,
      diabetes: isDisease('DM', 'เบาหวาน'), hypertension: isDisease('HT', 'ความดัน'),
      chronicDiseaseRecords: diseaseRows.length,
      homebound: homeBound, bedridden: bedBound,
      homeVisits: visits.length, visitsThisMonth: visitThisMonth,
      pendingApprovals: pending, highRiskHouseholds: riskHouseholds,
      volunteers: activeVolunteers, officers: activeOfficers
    },
    ageGroups: [
      { label: '0–5 ปี', count: filteredMembers.filter(function (m) { const age = memberAge(m); return age !== null && age <= 5; }).length },
      { label: '6–14 ปี', count: filteredMembers.filter(function (m) { const age = memberAge(m); return age !== null && age >= 6 && age <= 14; }).length },
      { label: '15–24 ปี', count: filteredMembers.filter(function (m) { const age = memberAge(m); return age !== null && age >= 15 && age <= 24; }).length },
      { label: '25–59 ปี', count: filteredMembers.filter(function (m) { const age = memberAge(m); return age !== null && age >= 25 && age <= 59; }).length },
      { label: '60 ปีขึ้นไป', count: olderAdults }
    ],
    gender: [
      { label: 'ชาย', count: genderCount('MALE') },
      { label: 'หญิง', count: genderCount('FEMALE') },
      { label: 'อื่น ๆ', count: filteredMembers.filter(function (m) { return ['MALE', 'FEMALE'].indexOf(String(m.gender).toUpperCase()) === -1; }).length }
    ],
    updatedAt: nowIso_()
  };
}

function actionReportsData_(token, data) {
  requireRole_(token, ['ADMIN', 'OFFICER']);
  const reportType = String(data.report_type || 'households').toLowerCase();
  const tableMap = {
    households: 'HOUSEHOLDS', members: 'FAMILY_MEMBERS', screenings: 'HEALTH_SCREENING',
    chronic: 'CHRONIC_DISEASE', risks: 'HEALTH_RISK', vaccinations: 'VACCINATIONS',
    visits: 'HOME_VISITS', appointments: 'APPOINTMENTS', approvals: 'APPROVAL_QUEUE'
  };
  const sheetName = tableMap[reportType];
  if (!sheetName) throw new Error('INVALID_INPUT');
  let rows = sheetName === 'APPROVAL_QUEUE' ? getRows_(sheetName) : filterActive_(getRows_(sheetName));
  if (data.moo && sheetName !== 'APPROVAL_QUEUE') {
    const householdIds = filterActive_(getRows_('HOUSEHOLDS')).filter(function (h) { return String(h.moo) === String(data.moo); }).map(function (h) { return String(h.household_id); });
    if (sheetName === 'HOUSEHOLDS') rows = rows.filter(function (r) { return String(r.moo) === String(data.moo); });
    else rows = rows.filter(function (r) { return householdIds.indexOf(String(r.household_id)) !== -1; });
  }
  if (data.from_date || data.to_date) {
    const dateFields = {
      HOUSEHOLDS: 'created_at', FAMILY_MEMBERS: 'date_of_birth', HEALTH_SCREENING: 'screening_date',
      CHRONIC_DISEASE: 'diagnosis_date', HEALTH_RISK: 'assessment_date', VACCINATIONS: 'vaccination_date',
      HOME_VISITS: 'visit_date', APPOINTMENTS: 'appointment_date', APPROVAL_QUEUE: 'created_at'
    };
    const dateField = dateFields[sheetName];
    if (data.from_date) rows = rows.filter(function (r) { return String(r[dateField] || '') >= String(data.from_date); });
    if (data.to_date) rows = rows.filter(function (r) { return String(r[dateField] || '') <= String(data.to_date); });
  }
  const paginated = paginate_(rows, data.page, data.pageSize);
  return { reportType: reportType, headers: getHeaders_(sheetName), result: paginated };
}

function actionReportsExportData_(token, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  const reportType = String(data.report_type || 'households').toLowerCase();
  const tableMap = {
    households: 'HOUSEHOLDS', members: 'FAMILY_MEMBERS', screenings: 'HEALTH_SCREENING',
    chronic: 'CHRONIC_DISEASE', risks: 'HEALTH_RISK', vaccinations: 'VACCINATIONS',
    visits: 'HOME_VISITS', appointments: 'APPOINTMENTS', approvals: 'APPROVAL_QUEUE'
  };
  const sheetName = tableMap[reportType];
  if (!sheetName) throw new Error('INVALID_INPUT');
  let rows = sheetName === 'APPROVAL_QUEUE' ? getRows_(sheetName) : filterActive_(getRows_(sheetName));
  if (data.moo && sheetName !== 'APPROVAL_QUEUE') {
    if (sheetName === 'HOUSEHOLDS') {
      rows = rows.filter(function (r) { return String(r.moo) === String(data.moo); });
    } else {
      const householdIds = filterActive_(getRows_('HOUSEHOLDS')).filter(function (h) { return String(h.moo) === String(data.moo); }).map(function (h) { return String(h.household_id); });
      rows = rows.filter(function (r) { return householdIds.indexOf(String(r.household_id)) !== -1; });
    }
  }
  const dateFieldMap = {
    HOUSEHOLDS: 'created_at', FAMILY_MEMBERS: 'date_of_birth', HEALTH_SCREENING: 'screening_date',
    CHRONIC_DISEASE: 'diagnosis_date', HEALTH_RISK: 'assessment_date', VACCINATIONS: 'vaccination_date',
    HOME_VISITS: 'visit_date', APPOINTMENTS: 'appointment_date', APPROVAL_QUEUE: 'created_at'
  };
  const dateField = dateFieldMap[sheetName];
  if (data.from_date) rows = rows.filter(function (r) { return String(r[dateField] || '') >= String(data.from_date); });
  if (data.to_date) rows = rows.filter(function (r) { return String(r[dateField] || '') <= String(data.to_date); });
  rows = rows.map(function (row) { const copy = Object.assign({}, row); delete copy.__rowNumber; return copy; });
  auditLog_(actor, 'REPORT_EXPORT_DATA', 'REPORT', reportType, 'เรียกข้อมูลทั้งหมดเพื่อส่งออกไฟล์', '', 'SUCCESS');
  return { reportType: reportType, headers: getHeaders_(sheetName), rows: rows, total: rows.length };
}

// =====================================================================================
// 16. NOTIFICATIONS
// =====================================================================================

function actionNotificationsList_(token, data) {
  const actor = requireAuth_(token);
  let rows = getRows_('NOTIFICATIONS').filter(function (row) {
    return String(row.recipient_user_id) === String(actor.user_id) ||
      (!row.recipient_user_id && String(row.recipient_role) === String(actor.role));
  });
  if (data.unread_only) rows = rows.filter(function (row) { return !normalizeBoolean_(row.is_read); });
  rows.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  return paginate_(rows, data.page, data.pageSize);
}

function actionNotificationMarkRead_(token, data) {
  const actor = requireAuth_(token);
  const id = String(data.notification_id || '');
  if (!id) throw new Error('INVALID_INPUT');
  const item = getRecordById_('NOTIFICATIONS', 'notification_id', id);
  if (String(item.recipient_user_id) !== String(actor.user_id) && String(item.recipient_role) !== String(actor.role)) throw new Error('PERMISSION_DENIED');
  updateRecordById_('NOTIFICATIONS', 'notification_id', id, { is_read: true, read_at: nowIso_() });
  return { is_read: true };
}

function notifyRole_(roles, title, message, type, entityType, entityId) {
  const users = getRows_('USERS').filter(function (user) {
    return normalizeBoolean_(user.is_active) && roles.indexOf(String(user.role)) !== -1;
  });
  users.forEach(function (user) {
    appendRecord_('NOTIFICATIONS', {
      notification_id: generateId_('NTF'), recipient_user_id: user.user_id,
      recipient_role: user.role, title: title, message: message,
      notification_type: type || 'INFO', related_entity_type: entityType || '',
      related_entity_id: entityId || '', is_read: false, created_at: nowIso_(),
      created_by: 'SYSTEM'
    });
  });
}

function notifyUser_(userId, title, message, type, entityType, entityId) {
  appendRecord_('NOTIFICATIONS', {
    notification_id: generateId_('NTF'), recipient_user_id: userId, recipient_role: '',
    title: title, message: message, notification_type: type || 'INFO',
    related_entity_type: entityType || '', related_entity_id: entityId || '',
    is_read: false, created_at: nowIso_(), created_by: 'SYSTEM'
  });
}

// =====================================================================================
// 16A. BULK IMPORT (CSV/XLSX IS PARSED IN THE FRONTEND, THEN SENT AS JSON ROWS)
// =====================================================================================

function actionBulkImport_(token, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER']);
  const entityType = String(data.entity_type || '').toUpperCase();
  const allowed = ['HOUSEHOLDS', 'FAMILY_MEMBERS', 'HEALTH_SCREENING', 'CHRONIC_DISEASE', 'HEALTH_RISK', 'VACCINATIONS', 'HOME_VISITS', 'APPOINTMENTS'];
  if (allowed.indexOf(entityType) === -1 || !Array.isArray(data.items) || data.items.length === 0 || data.items.length > 250) {
    throw new Error('INVALID_INPUT');
  }
  const results = [];
  let succeeded = 0;
  let failed = 0;
  data.items.forEach(function (item, index) {
    try {
      const created = actionEntityCreate_(token, entityType, requireObject_(item));
      succeeded++;
      results.push({ row: index + 1, success: true, record_id: created[TABLE_ID_FIELDS[entityType]] || '' });
    } catch (error) {
      failed++;
      results.push({ row: index + 1, success: false, message: getPublicErrorMessage_(error) });
    }
  });
  auditLog_(actor, 'BULK_IMPORT', entityType, '', 'นำเข้าข้อมูลจำนวน ' + data.items.length + ' รายการ', '', failed ? 'PARTIAL' : 'SUCCESS');
  return { entity_type: entityType, total: data.items.length, succeeded: succeeded, failed: failed, results: results };
}

// =====================================================================================
// 17. IMGBB IMAGE UPLOAD
// =====================================================================================

function actionUploadImage_(token, data) {
  const actor = requireRole_(token, ['ADMIN', 'OFFICER', 'VOLUNTEER']);
  const apiKey = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEYS.IMGBB_API_KEY);
  if (!apiKey) throw new Error('IMG_UPLOAD_NOT_CONFIGURED');
  const base64 = String(data.base64 || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  if (!base64) throw new Error('INVALID_INPUT');
  const estimatedBytes = Math.floor(base64.length * 3 / 4);
  if (estimatedBytes > APP_CONFIG.MAX_IMAGE_BYTES) throw new Error('IMAGE_TOO_LARGE');
  const mimeType = String(data.mimeType || 'image/jpeg');
  if (mimeType.indexOf('image/') !== 0) throw new Error('INVALID_INPUT');

  const response = UrlFetchApp.fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(apiKey), {
    method: 'post',
    payload: { image: base64, name: String(data.fileName || ('image-' + Date.now())) },
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  let result;
  try { result = JSON.parse(response.getContentText()); } catch (error) { throw new Error('IMG_UPLOAD_FAILED'); }
  if (status < 200 || status >= 300 || !result || !result.success || !result.data || !result.data.url) {
    writeSystemLog_('WARN', 'ImgBB', 'อัปโหลดรูปภาพไม่สำเร็จ', { status: status, response: response.getContentText().substring(0, 1000) }, '');
    throw new Error('IMG_UPLOAD_FAILED');
  }
  auditLog_(actor, 'IMAGE_UPLOAD', 'IMAGE', '', 'อัปโหลดรูปภาพไปยัง ImgBB', '', 'SUCCESS');
  return {
    url: String(result.data.url),
    display_url: String(result.data.display_url || result.data.url),
    thumb_url: result.data.thumb && result.data.thumb.url ? String(result.data.thumb.url) : '',
    file_name: String(result.data.image && result.data.image.filename ? result.data.image.filename : data.fileName || '')
  };
}

// =====================================================================================
// 18. EXPORT / BACKUP DATA (FRONTEND DOWNLOADS DIRECTLY TO THE USER'S DEVICE)
// =====================================================================================

function actionBackupExportJson_(token, data) {
  const actor = requireRole_(token, ['ADMIN']);
  const includeSensitive = normalizeBoolean_(data.include_sensitive);
  const backup = {
    exported_at: nowIso_(),
    system_name: APP_CONFIG.NAME,
    version: APP_CONFIG.VERSION,
    sheets: {}
  };
  Object.keys(SHEET_HEADERS).forEach(function (sheetName) {
    let rows = getRows_(sheetName);
    if (sheetName === 'SESSIONS') {
      rows = rows.map(function (row) { const copy = Object.assign({}, row); copy.token_hash = ''; copy.is_revoked = true; return copy; });
    }
    if (sheetName === 'USERS') {
      rows = rows.map(function (row) {
        const copy = Object.assign({}, row);
        delete copy.password_hash;
        delete copy.password_salt;
        delete copy.password_iterations;
        delete copy.failed_login_count;
        delete copy.locked_until;
        return copy;
      });
    }
    if (!includeSensitive) {
      if (sheetName === 'FAMILY_MEMBERS') {
        rows = rows.map(function (row) { const copy = Object.assign({}, row); copy.national_id = ''; copy.phone = ''; return copy; });
      }
    }
    backup.sheets[sheetName] = rows;
  });
  const counts = Object.keys(backup.sheets).reduce(function (sum, key) { return sum + backup.sheets[key].length; }, 0);
  appendRecord_('BACKUP_LOG', {
    backup_id: generateId_('BKP'), backup_time: nowIso_(), backup_type: 'JSON_EXPORT',
    requested_by: actor.user_id, requested_by_name: actor.full_name,
    record_count: counts, result: 'SUCCESS', notes: includeSensitive ? 'รวมข้อมูลส่วนบุคคลตามสิทธิ์ผู้ดูแลระบบ' : 'ปกปิดเลขบัตรประชาชนและเบอร์โทรศัพท์'
  });
  auditLog_(actor, 'BACKUP_EXPORT', 'SYSTEM', '', 'ส่งออกข้อมูลสำรองแบบ JSON', '', 'SUCCESS');
  return { fileName: 'watkao-family-health-backup-' + nowIso_().substring(0, 10) + '.json', mimeType: 'application/json', content: JSON.stringify(backup) };
}

// =====================================================================================
// 19. AUDIT LOG AND SYSTEM LOG
// =====================================================================================

function auditLog_(user, action, entityType, entityId, description, requestId, result) {
  try {
    appendRecord_('AUDIT_LOG', {
      audit_id: generateId_('AUD'), event_time: nowIso_(),
      user_id: user ? user.user_id : '', username: user ? user.username : '',
      full_name: user ? user.full_name : '', role: user ? user.role : '',
      action: String(action || ''), entity_type: String(entityType || ''),
      entity_id: String(entityId || ''), description: String(description || ''),
      request_id: String(requestId || ''), result: String(result || 'SUCCESS')
    });
  } catch (error) {
    // Audit failure must not expose technical details to the client.
    writeSystemLog_('WARN', 'Audit', 'บันทึกประวัติการใช้งานไม่สำเร็จ', error, requestId);
  }
}

function actionAuditList_(token, data) {
  requireRole_(token, ['ADMIN']);
  let rows = getRows_('AUDIT_LOG');
  if (data.user_id) rows = rows.filter(function (r) { return String(r.user_id) === String(data.user_id); });
  if (data.action) rows = rows.filter(function (r) { return String(r.action) === String(data.action); });
  if (data.entity_type) rows = rows.filter(function (r) { return String(r.entity_type) === String(data.entity_type); });
  if (data.entity_id) rows = rows.filter(function (r) { return String(r.entity_id) === String(data.entity_id); });
  if (data.from_date) rows = rows.filter(function (r) { return String(r.event_time || '') >= String(data.from_date); });
  if (data.to_date) rows = rows.filter(function (r) { return String(r.event_time || '') <= String(data.to_date); });
  rows.sort(function (a, b) { return String(b.event_time || '').localeCompare(String(a.event_time || '')); });
  return paginate_(rows, data.page, data.pageSize);
}

function writeSystemLog_(level, component, message, details, requestId) {
  try {
    const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID);
    if (!spreadsheetId) return;
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    let sheet = spreadsheet.getSheetByName('SYSTEM_LOG');
    if (!sheet) {
      sheet = spreadsheet.insertSheet('SYSTEM_LOG');
      sheet.getRange(1, 1, 1, SHEET_HEADERS.SYSTEM_LOG.length).setValues([SHEET_HEADERS.SYSTEM_LOG]);
    }
    sheet.appendRow([
      generateId_('LOG'), nowIso_(), String(level || 'INFO'), String(component || ''),
      String(message || ''), JSON.stringify(safeErrorDetails_(details)).substring(0, 4000), String(requestId || '')
    ]);
  } catch (ignored) {
    // Deliberately silent: system logging must never break the main request.
  }
}

function safeErrorDetails_(details) {
  if (!details) return {};
  if (details instanceof Error) return { name: details.name, message: details.message, stack: String(details.stack || '').substring(0, 2000) };
  if (typeof details === 'object') return details;
  return { detail: String(details) };
}

// =====================================================================================
// 20. SYSTEM INFORMATION AND HEALTH CHECK
// =====================================================================================

function actionSystemLogsList_(token, data) {
  requireRole_(token, ['ADMIN']);
  let rows = getRows_('SYSTEM_LOG');
  if (data.level) rows = rows.filter(function (row) { return String(row.level) === String(data.level); });
  if (data.component) rows = rows.filter(function (row) { return String(row.component) === String(data.component); });
  if (data.from_date) rows = rows.filter(function (row) { return String(row.event_time || '') >= String(data.from_date); });
  if (data.to_date) rows = rows.filter(function (row) { return String(row.event_time || '') <= String(data.to_date); });
  rows.sort(function (a, b) { return String(b.event_time || '').localeCompare(String(a.event_time || '')); });
  return paginate_(rows, data.page, data.pageSize);
}

function actionSystemHealth_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID);
  let databaseReady = false;
  let sheetCount = 0;
  if (spreadsheetId) {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    databaseReady = true;
    sheetCount = spreadsheet.getSheets().length;
  }
  return {
    status: databaseReady ? 'READY' : 'NOT_INITIALIZED',
    databaseReady: databaseReady,
    sheetCount: sheetCount,
    version: APP_CONFIG.VERSION,
    time: nowIso_()
  };
}

function actionSystemClearSessions_(token) {
  const actor = requireRole_(token, ['ADMIN']);
  const result = clearAllSessions();
  auditLog_(actor, 'SYSTEM_CLEAR_SESSIONS', 'SYSTEM', '', 'ยกเลิกเซสชันผู้ใช้งานทั้งหมด', '', 'SUCCESS');
  return { cleared: true, message: result };
}

function actionSystemInstallReminders_(token) {
  const actor = requireRole_(token, ['ADMIN']);
  const result = installDailyReminderTrigger();
  auditLog_(actor, 'SYSTEM_INSTALL_REMINDERS', 'SYSTEM', '', 'ติดตั้งระบบแจ้งเตือนประจำวัน', '', 'SUCCESS');
  return { installed: true, message: result };
}

function actionSystemInfo_() {
  return {
    name: PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEYS.SYSTEM_NAME) || APP_CONFIG.NAME,
    version: APP_CONFIG.VERSION,
    organization: 'โรงพยาบาลส่งเสริมสุขภาพตำบลวัดเกาะ',
    subdistrict: 'วัดเกาะ', district: 'ศรีสำโรง', province: 'สุโขทัย',
    timeZone: APP_CONFIG.TIME_ZONE,
    apiUrl: ScriptApp.getService().getUrl() || '',
    transport: { publicGet: 'JSONP', authenticatedRequests: 'FORM_IFRAME_POSTMESSAGE' },
    roles: ROLE_LABELS,
    loginRequired: true
  };
}

// =====================================================================================
// 21. VALIDATION AND UTILITY HELPERS
// =====================================================================================

function isValidDate_(value) {
  if (!value) return false;
  const date = new Date(value);
  return !isNaN(date.getTime());
}

function normalizeThaiDate_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return text;
}

function safeText_(value, maxLength) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text.substring(0, maxLength || 1000);
}

function requireObject_(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT');
  return value;
}

// =====================================================================================
// 21A. DAILY FOLLOW-UP REMINDERS (IN-APP NOTIFICATIONS)
// =====================================================================================

/** Run once manually to install a daily trigger at approximately 07:00 Bangkok time. */
function installDailyReminderTrigger() {
  const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'runDailyReminders';
  });
  existing.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('runDailyReminders').timeBased().everyDays(1).atHour(7).inTimezone(APP_CONFIG.TIME_ZONE).create();
  return 'ติดตั้งระบบแจ้งเตือนติดตามงานประจำวันเรียบร้อยแล้ว';
}

/**
 * Daily trigger: creates in-app notifications for overdue/today follow-ups.
 * Notifications are internal to this system; this function does not send SMS or LINE.
 */
function runDailyReminders() {
  ensureDatabaseReady_();
  const today = Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  let created = 0;
  getRows_('SESSIONS').forEach(function (session) {
    if (!normalizeBoolean_(session.is_revoked) && session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
      updateRecordById_('SESSIONS', 'session_id', session.session_id, { is_revoked: true });
    }
  });

  filterActive_(getRows_('HOUSEHOLDS')).forEach(function (household) {
    const due = String(household.next_followup_date || '').substring(0, 10);
    if (due && due <= today) {
      created += createReminderIfMissing_(
        'HOUSEHOLD_FOLLOWUP', 'ติดตามเยี่ยมครัวเรือน',
        'ครัวเรือนเลขที่ ' + String(household.house_number || '-') + ' หมู่ ' + String(household.moo || '-') + ' ถึงกำหนดติดตามแล้ว',
        'HOUSEHOLD', household.household_id
      );
    }
  });

  filterActive_(getRows_('CHRONIC_DISEASE')).forEach(function (record) {
    const due = String(record.next_followup_date || '').substring(0, 10);
    if (due && due <= today) {
      created += createReminderIfMissing_(
        'CHRONIC_FOLLOWUP', 'ติดตามผู้ป่วยโรคเรื้อรัง',
        'มีผู้ป่วยโรค ' + String(record.disease_name || record.disease_code || '') + ' ถึงกำหนดติดตาม',
        'CHRONIC_DISEASE', record.chronic_id
      );
    }
  });

  filterActive_(getRows_('APPOINTMENTS')).forEach(function (appointment) {
    const due = String(appointment.appointment_date || '').substring(0, 10);
    const status = String(appointment.appointment_status || '').toUpperCase();
    if (due && due <= today && ['DONE', 'COMPLETED', 'CANCELLED'].indexOf(status) === -1) {
      created += createReminderIfMissing_(
        'APPOINTMENT_DUE', 'แจ้งเตือนนัดหมาย',
        'มีนัดหมายวันที่ ' + due + ' ประเภท ' + String(appointment.appointment_type || appointment.purpose || ''),
        'APPOINTMENT', appointment.appointment_id
      );
    }
  });

  writeSystemLog_('INFO', 'DailyReminders', 'ตรวจสอบรายการติดตามประจำวันแล้ว', { created: created, date: today }, '');
  return { date: today, notificationsCreated: created };
}

function createReminderIfMissing_(type, title, message, entityType, entityId) {
  const today = Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  const existing = getRows_('NOTIFICATIONS').some(function (row) {
    return String(row.notification_type) === type &&
      String(row.related_entity_id) === String(entityId) &&
      String(row.created_at || '').substring(0, 10) === today;
  });
  if (existing) return 0;
  notifyRole_(['ADMIN', 'OFFICER'], title, message, type, entityType, entityId);
  return 1;
}

// =====================================================================================
// 22. OPTIONAL SPREADSHEET MENU FOR ADMINISTRATOR
// =====================================================================================

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('ระบบแผนผังครอบครัว')
      .addItem('สร้าง/ตรวจสอบชีตและหัวตาราง', 'initializeSystem')
      .addSeparator()
      .addItem('แสดงข้อมูลการตั้งค่า', 'showSystemSetupInfo')
      .addToUi();
  } catch (error) {
    // onOpen may be invoked in a context without a spreadsheet UI.
  }
}

function showSystemSetupInfo() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID) || '(ยังไม่ได้สร้าง)';
  const message = [
    'ระบบ: ' + APP_CONFIG.NAME,
    'เวอร์ชัน: ' + APP_CONFIG.VERSION,
    'Spreadsheet ID: ' + spreadsheetId,
    'ImgBB API Key: ' + (properties.getProperty(SCRIPT_PROPERTY_KEYS.IMGBB_API_KEY) ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้งค่า'),
    '',
    'นำ URL /exec นี้ไปตั้งเป็น GAS_WEB_APP_URL ใน Cloudflare Worker แล้วตั้ง API_URL ในหน้าเว็บ GitHub เป็น URL ของ Worker (คำขอที่มีข้อมูลส่วนบุคคลต้องใช้ POST)'
  ].join('\n');
  SpreadsheetApp.getUi().alert('ข้อมูลการตั้งค่าระบบ', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

// =====================================================================================
// 23. DEVELOPER / MAINTENANCE UTILITIES
// =====================================================================================

/** Run manually when you add new header definitions to SHEET_HEADERS. */
function rebuildAllHeaders() {
  return initializeSystem();
}

/** Verify that all expected sheets and columns exist. */
function validateDatabaseStructure() {
  const spreadsheet = getOrCreateSpreadsheet_();
  const report = [];
  Object.keys(SHEET_HEADERS).forEach(function (sheetName) {
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      report.push({ sheet: sheetName, exists: false, missingHeaders: SHEET_HEADERS[sheetName] });
      return;
    }
    const headers = getHeaders_(sheetName);
    report.push({
      sheet: sheetName,
      exists: true,
      headerCount: headers.length,
      missingHeaders: SHEET_HEADERS[sheetName].filter(function (header) { return headers.indexOf(header) === -1; })
    });
  });
  return report;
}

/** Clear all active sessions. Use after a security incident or major credential change. */
function clearAllSessions() {
  // Increment the server-side session epoch; every previously issued token becomes invalid.
  PropertiesService.getScriptProperties().setProperty('SESSION_VERSION_EPOCH', Utilities.getUuid());
  return 'ยกเลิกเซสชันทั้งหมดเรียบร้อยแล้ว ผู้ใช้ทุกคนต้องเข้าสู่ระบบใหม่';
}

function getSessionVersion_() {
  return PropertiesService.getScriptProperties().getProperty('SESSION_VERSION_EPOCH') || APP_CONFIG.SESSION_VERSION;
}

// =====================================================================================
// END OF CODE.GS
// =====================================================================================
