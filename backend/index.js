require('dotenv').config()

const express = require('express')
const cors = require('cors')
const multer = require('multer')
const path = require('path')
const fs = require('fs/promises')
const pdfParse = require('pdf-parse')
const mammoth = require('mammoth')
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx')
const puppeteer = require('puppeteer')
const OpenAI = require('openai')

const app = express()
const PORT = process.env.PORT || 5001

app.use(cors())
app.use(express.json({ limit: '2mb' }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const allowedExt = ['.pdf', '.docx', '.txt']
    const allowedMime = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ]

    if (allowedExt.includes(ext) || allowedMime.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Unsupported file type. Upload PDF, DOCX, or TXT.'))
    }
  },
})

const parseMultipart = (req, res, next) => {
  if (req.is('multipart/form-data')) {
    return upload.single('resumeFile')(req, res, next)
  }
  return next()
}

let openaiClient = null

const getOpenAIClient = () => {
  const apiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set.')
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey })
  }
  return openaiClient
}

const gradeFromScore = (score) => {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B+'
  if (score >= 70) return 'B'
  if (score >= 60) return 'C'
  return 'D'
}

const detectRoleTitle = (jobDescription = '') => {
  const match = jobDescription.match(
    /(Senior|Lead|Principal|Staff)?\s*([A-Za-z\s]+?)(Engineer|Developer|Designer|Manager)/i
  )
  if (!match) return 'Target Role'
  return `${match[1] ? `${match[1]} ` : ''}${match[2].trim()} ${match[3]}`.replace(/\s+/g, ' ')
}

const normalizeList = (list) => {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))]
}

const experienceTemplate = {
  company: '',
  role: '',
  location: '',
  startDate: '',
  endDate: '',
  isCurrent: '',
  points: [],
}

const projectTemplate = {
  name: '',
  technologies: '',
  link: '',
  points: [],
}

const educationTemplate = {
  institution: '',
  degree: '',
  field: '',
  startDate: '',
  endDate: '',
}

const certificateTemplate = {
  name: '',
  issuer: '',
  year: '',
}

const emptyResumeJson = {
  basics: {
    name: '',
    email: '',
    phone: '',
    location: '',
    linkedin: '',
    github: '',
    portfolio: '',
  },
  summary: { id: 'summary-1', text: '' },
  skills: [],
  experience: [],
  projects: [],
  education: [],
  certificates: [],
}

const emptyAnalysisJson = {
  'Required Keywords': [],
  'Matching Keywords': [],
  'Missing Keywords': [],
  Analysis: [],
  summary: { id: 'summary-1', text: '' },
  skills: [],
  experience: [],
  projects: [],
  education: [],
  certificates: [],
}

const normalizeSummaryValue = (summary, fallbackId = 'summary-1') => {
  if (summary && typeof summary === 'object') {
    return {
      id: typeof summary.id === 'string' && summary.id.trim() ? summary.id.trim() : fallbackId,
      text: typeof summary.text === 'string' ? summary.text : '',
    }
  }
  if (typeof summary === 'string') {
    return { id: fallbackId, text: summary }
  }
  return { id: fallbackId, text: '' }
}

const normalizeSkillEntry = (entry, index, fallbackId) => {
  if (!entry || typeof entry !== 'object') return null
  const normalized = { ...entry }
  const idValue =
    typeof normalized.id === 'string' && normalized.id.trim()
      ? normalized.id.trim()
      : fallbackId || `skill-${index + 1}`
  normalized.id = idValue
  return normalized
}

const normalizeSkillsList = (skills, resumeSkills) => {
  const list = Array.isArray(skills) ? skills : []
  const fallback = Array.isArray(resumeSkills) ? resumeSkills : []
  const maxLen = Math.max(list.length, fallback.length)
  const normalized = []
  for (let i = 0; i < maxLen; i += 1) {
    const entry = list[i]
    const fallbackEntry = fallback[i]
    if (!entry && !fallbackEntry) continue
    const fallbackId =
      fallbackEntry && typeof fallbackEntry === 'object' && typeof fallbackEntry.id === 'string'
        ? fallbackEntry.id
        : `skill-${i + 1}`
    const normalizedEntry = normalizeSkillEntry(entry || fallbackEntry, i, fallbackId)
    if (normalizedEntry) normalized.push(normalizedEntry)
  }
  return normalized
}

const getPointText = (point) => {
  if (typeof point === 'string') return point
  if (point && typeof point === 'object') {
    if (typeof point.text === 'string') return point.text
    if (typeof point.value === 'string') return point.value
  }
  return ''
}

const normalizePointsList = (points, resumePoints, prefix) => {
  const list = Array.isArray(points) ? points : []
  const fallback = Array.isArray(resumePoints) ? resumePoints : []
  const maxLen = Math.max(list.length, fallback.length)
  const normalized = []
  for (let i = 0; i < maxLen; i += 1) {
    const point = list[i]
    const fallbackPoint = fallback[i]
    if (!point && !fallbackPoint) continue
    const idValue =
      (point && typeof point === 'object' && typeof point.id === 'string' && point.id.trim()) ||
      (fallbackPoint &&
        typeof fallbackPoint === 'object' &&
        typeof fallbackPoint.id === 'string' &&
        fallbackPoint.id.trim()) ||
      `${prefix}-${i + 1}`
    const textValue = getPointText(point || fallbackPoint)
    normalized.push({ id: idValue, text: textValue })
  }
  return normalized
}

const normalizeArrayObjects = (list, template, fallbackList) => {
  const items = Array.isArray(list) ? list : []
  const fallback = Array.isArray(fallbackList) ? fallbackList : []
  const maxLen = Math.max(items.length, fallback.length)
  const normalized = []
  for (let i = 0; i < maxLen; i += 1) {
    const item = items[i]
    const fallbackItem = fallback[i]
    if (!item && !fallbackItem) continue
    normalized.push({
      ...template,
      ...(fallbackItem && typeof fallbackItem === 'object' ? fallbackItem : {}),
      ...(item && typeof item === 'object' ? item : {}),
    })
  }
  return normalized
}

const normalizeExperienceList = (list, resumeList) => {
  const items = Array.isArray(list) ? list : []
  const fallback = Array.isArray(resumeList) ? resumeList : []
  const maxLen = Math.max(items.length, fallback.length)
  const normalized = []
  for (let i = 0; i < maxLen; i += 1) {
    const item = items[i]
    const fallbackItem = fallback[i]
    if (!item && !fallbackItem) continue
    const merged = {
      ...experienceTemplate,
      ...(fallbackItem && typeof fallbackItem === 'object' ? fallbackItem : {}),
      ...(item && typeof item === 'object' ? item : {}),
    }
    merged.points = normalizePointsList(item?.points, fallbackItem?.points, `exp-${i + 1}`)
    normalized.push(merged)
  }
  return normalized
}

const normalizeProjectList = (list, resumeList) => {
  const items = Array.isArray(list) ? list : []
  const fallback = Array.isArray(resumeList) ? resumeList : []
  const maxLen = Math.max(items.length, fallback.length)
  const normalized = []
  for (let i = 0; i < maxLen; i += 1) {
    const item = items[i]
    const fallbackItem = fallback[i]
    if (!item && !fallbackItem) continue
    const merged = {
      ...projectTemplate,
      ...(fallbackItem && typeof fallbackItem === 'object' ? fallbackItem : {}),
      ...(item && typeof item === 'object' ? item : {}),
    }
    merged.points = normalizePointsList(item?.points, fallbackItem?.points, `proj-${i + 1}`)
    normalized.push(merged)
  }
  return normalized
}

const normalizeResumeJson = (input) => {
  const base = { ...emptyResumeJson }
  if (input && typeof input === 'object') {
    base.basics = { ...base.basics, ...(input.basics || {}) }
    base.summary = normalizeSummaryValue(input.summary)
    base.skills = normalizeSkillsList(input.skills)
    base.experience = normalizeExperienceList(input.experience)
    base.projects = normalizeProjectList(input.projects)
    base.education = normalizeArrayObjects(input.education, educationTemplate)
    base.certificates = normalizeArrayObjects(input.certificates, certificateTemplate)
  }
  return base
}

const normalizeAnalysisJson = (input, resumeJson) => {
  const base = { ...emptyAnalysisJson }
  if (input && typeof input === 'object') {
    base['Required Keywords'] = normalizeList(input['Required Keywords'])
    base['Matching Keywords'] = normalizeList(input['Matching Keywords'])
    base['Missing Keywords'] = normalizeList(input['Missing Keywords'])
    base.Analysis = normalizeList(input.Analysis)
    base.summary = normalizeSummaryValue(input.summary, resumeJson.summary?.id || 'summary-1')
    base.skills = normalizeSkillsList(input.skills, resumeJson.skills)
    base.experience = normalizeExperienceList(input.experience, resumeJson.experience)
    base.projects = normalizeProjectList(input.projects, resumeJson.projects)
    base.education = normalizeArrayObjects(input.education, educationTemplate, resumeJson.education)
    base.certificates = normalizeArrayObjects(input.certificates, certificateTemplate, resumeJson.certificates)
  }

  base.summary = base.summary?.text ? base.summary : resumeJson.summary
  base.skills = base.skills.length ? base.skills : resumeJson.skills
  base.experience = base.experience.length ? base.experience : resumeJson.experience
  base.projects = base.projects.length ? base.projects : resumeJson.projects
  base.education = base.education.length ? base.education : resumeJson.education
  base.certificates = base.certificates.length ? base.certificates : resumeJson.certificates

  return base
}

const saveLlmResult = async (data) => {
  try {
    const filePath = path.join(__dirname, 'llm-result.json')
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    console.error('Failed to save llm-result.json:', err.message)
  }
}

const extractSkillLabelValue = (entry) => {
  if (!entry || typeof entry !== 'object') return { label: '', value: '' }
  if (typeof entry.label === 'string' || typeof entry.value === 'string') {
    return {
      label: typeof entry.label === 'string' ? entry.label : '',
      value: typeof entry.value === 'string' ? entry.value : '',
    }
  }
  const keys = Object.keys(entry).filter((key) => key !== 'id')
  const label = keys[0] || ''
  const value = label ? entry[label] : ''
  return {
    label,
    value: typeof value === 'string' ? value : '',
  }
}

const skillsToText = (skills = []) =>
  (Array.isArray(skills) ? skills : [])
    .map((entry) => {
      const { label, value } = extractSkillLabelValue(entry)
      if (!label && !value) return ''
      return value ? `${label}: ${value}` : label
    })
    .filter(Boolean)
    .join(' · ')

const getSummaryTextValue = (summary) => (typeof summary === 'string' ? summary : summary?.text || '')

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const buildSectionHtml = (title, content) => {
  if (!content) return ''
  return `<section><h2>${escapeHtml(title)}</h2>${content}</section>`
}

const buildBulletsHtml = (points = []) => {
  const items = points
    .map((point) => getPointText(point))
    .filter(Boolean)
    .map((text) => `<li>${escapeHtml(text)}</li>`)
  if (!items.length) return ''
  return `<ul>${items.join('')}</ul>`
}

const buildSkillEntries = (skills = []) =>
  (Array.isArray(skills) ? skills : [])
    .map((entry) => {
      const { label, value } = extractSkillLabelValue(entry)
      if (!label && !value) return ''
      return value ? `${label}: ${value}` : label
    })
    .filter(Boolean)

const generateResumeHtml = (resumeJson) => {
  const basics = resumeJson.basics || {}
  const name = basics.name || 'Candidate'
  const contactParts = [
    basics.location,
    basics.email,
    basics.phone,
    basics.linkedin,
    basics.github,
    basics.portfolio,
  ].filter(Boolean)

  const summaryText = getSummaryTextValue(resumeJson.summary)

  const experienceList = Array.isArray(resumeJson.experience)
    ? resumeJson.experience.filter((job) =>
        [job.role, job.company, job.location, job.startDate, job.endDate, job.isCurrent]
          .filter(Boolean)
          .join('')
          .trim() || (job.points || []).some((point) => getPointText(point))
      )
    : []
  const experienceHtml = experienceList
    .map((job) => {
      const headingParts = [job.role, job.company].filter(Boolean).join(' · ')
      const subParts = [
        job.location,
        [job.startDate, job.endDate || (job.isCurrent ? 'Present' : '')].filter(Boolean).join(' - '),
      ].filter(Boolean)
      return `
        <div class="entry">
          ${headingParts ? `<h3>${escapeHtml(headingParts)}</h3>` : ''}
          ${subParts.length ? `<div class="meta">${escapeHtml(subParts.join(' · '))}</div>` : ''}
          ${buildBulletsHtml(job.points)}
        </div>`
    })
    .join('')

  const projectList = Array.isArray(resumeJson.projects)
    ? resumeJson.projects.filter((project) =>
        [project.name, project.technologies, project.link].filter(Boolean).join('').trim() ||
          (project.points || []).some((point) => getPointText(point))
      )
    : []
  const projectsHtml = projectList
    .map((project) => {
      const headingParts = [project.name, project.technologies].filter(Boolean).join(' · ')
      return `
        <div class="entry">
          ${headingParts ? `<h3>${escapeHtml(headingParts)}</h3>` : ''}
          ${project.link ? `<div class="meta">${escapeHtml(project.link)}</div>` : ''}
          ${buildBulletsHtml(project.points)}
        </div>`
    })
    .join('')

  const skillEntries = buildSkillEntries(resumeJson.skills)
  const skillsHtml = skillEntries.length
    ? `<ul>${skillEntries.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
    : ''

  const educationList = Array.isArray(resumeJson.education) ? resumeJson.education : []
  const educationHtml = educationList
    .filter((edu) =>
      [edu.degree, edu.field, edu.institution, edu.startDate, edu.endDate].filter(Boolean).join('').trim()
    )
    .map((edu) => {
      const headingParts = [edu.degree, edu.field].filter(Boolean).join(' · ')
      const lineParts = [edu.institution, [edu.startDate, edu.endDate].filter(Boolean).join(' - ')]
        .filter(Boolean)
        .join(' · ')
      return `
        <div class="entry">
          ${headingParts ? `<h3>${escapeHtml(headingParts)}</h3>` : ''}
          ${lineParts ? `<div class="meta">${escapeHtml(lineParts)}</div>` : ''}
        </div>`
    })
    .join('')

  const certificatesList = Array.isArray(resumeJson.certificates) ? resumeJson.certificates : []
  const certificatesHtml = certificatesList
    .filter((cert) => [cert.name, cert.issuer, cert.year].filter(Boolean).join('').trim())
    .map((cert) => {
      const headingParts = [cert.name, cert.issuer].filter(Boolean).join(' · ')
      return `
        <div class="entry">
          ${headingParts ? `<h3>${escapeHtml(headingParts)}</h3>` : ''}
          ${cert.year ? `<div class="meta">${escapeHtml(cert.year)}</div>` : ''}
        </div>`
    })
    .join('')

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          :root { color-scheme: light; }
          body {
            font-family: "Helvetica Neue", Arial, sans-serif;
            color: #0f172a;
            margin: 0;
            padding: 24mm 18mm;
            font-size: 11pt;
            line-height: 1.5;
          }
          h1 {
            font-size: 22pt;
            margin: 0 0 6px;
          }
          .contact {
            font-size: 9.5pt;
            color: #475569;
            margin-bottom: 18px;
          }
          h2 {
            font-size: 12pt;
            margin: 18px 0 6px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
          }
          h3 {
            font-size: 11pt;
            margin: 10px 0 2px;
          }
          .meta {
            font-size: 9pt;
            color: #64748b;
            margin-bottom: 6px;
          }
          ul {
            margin: 6px 0 12px 18px;
            padding: 0;
          }
          li { margin-bottom: 4px; }
          section { margin-bottom: 12px; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(name)}</h1>
        ${contactParts.length ? `<div class="contact">${escapeHtml(contactParts.join(' · '))}</div>` : ''}
        ${buildSectionHtml('Summary', summaryText ? `<p>${escapeHtml(summaryText)}</p>` : '')}
        ${buildSectionHtml('Experience', experienceHtml)}
        ${buildSectionHtml('Projects', projectsHtml)}
        ${buildSectionHtml('Skills', skillsHtml)}
        ${buildSectionHtml('Education', educationHtml)}
        ${buildSectionHtml('Certificates', certificatesHtml)}
      </body>
    </html>
  `
}

const generateResumeDocxBuffer = async (resumeJson) => {
  const basics = resumeJson.basics || {}
  const name = basics.name || 'Candidate'
  const contactParts = [
    basics.location,
    basics.email,
    basics.phone,
    basics.linkedin,
    basics.github,
    basics.portfolio,
  ].filter(Boolean)

  const sectionTitle = (text) =>
    new Paragraph({
      text,
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 120 },
    })

  const children = [
    new Paragraph({
      children: [new TextRun({ text: name, bold: true, size: 32 })],
      spacing: { after: 120 },
    }),
  ]

  if (contactParts.length) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: contactParts.join(' · '), size: 20, color: '6B7280' })],
        spacing: { after: 180 },
      })
    )
  }

  const summaryText = getSummaryTextValue(resumeJson.summary)
  if (summaryText) {
    children.push(sectionTitle('Summary'))
    children.push(new Paragraph({ text: summaryText }))
  }

  const experienceList = Array.isArray(resumeJson.experience)
    ? resumeJson.experience.filter((job) =>
        [job.role, job.company, job.location, job.startDate, job.endDate, job.isCurrent]
          .filter(Boolean)
          .join('')
          .trim() || (job.points || []).some((point) => getPointText(point))
      )
    : []
  if (experienceList.length) {
    children.push(sectionTitle('Experience'))
  }
  experienceList.forEach((job) => {
    const headingParts = [job.role, job.company].filter(Boolean).join(' · ')
    if (headingParts) {
      children.push(new Paragraph({ children: [new TextRun({ text: headingParts, bold: true })] }))
    }
    const subParts = [
      job.location,
      [job.startDate, job.endDate || (job.isCurrent ? 'Present' : '')].filter(Boolean).join(' - '),
    ].filter(Boolean)
    if (subParts.length) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: subParts.join(' · '), size: 20, color: '6B7280' })],
        })
      )
    }
    ;(job.points || [])
      .filter((point) => getPointText(point))
      .forEach((point) => {
        children.push(
          new Paragraph({
            text: getPointText(point),
            bullet: { level: 0 },
          })
        )
      })
  })

  const projectList = Array.isArray(resumeJson.projects)
    ? resumeJson.projects.filter((project) =>
        [project.name, project.technologies, project.link].filter(Boolean).join('').trim() ||
          (project.points || []).some((point) => getPointText(point))
      )
    : []
  if (projectList.length) {
    children.push(sectionTitle('Projects'))
  }
  projectList.forEach((project) => {
    const headingParts = [project.name, project.technologies].filter(Boolean).join(' · ')
    if (headingParts) {
      children.push(new Paragraph({ children: [new TextRun({ text: headingParts, bold: true })] }))
    }
    if (project.link) {
      children.push(new Paragraph({ children: [new TextRun({ text: project.link, size: 20, color: '6B7280' })] }))
    }
    ;(project.points || [])
      .filter((point) => getPointText(point))
      .forEach((point) => {
        children.push(
          new Paragraph({
            text: getPointText(point),
            bullet: { level: 0 },
          })
        )
      })
  })

  const skillEntries = buildSkillEntries(resumeJson.skills)
  if (skillEntries.length) {
    children.push(sectionTitle('Skills'))
    skillEntries.forEach((text) => {
      children.push(
        new Paragraph({
          text,
          bullet: { level: 0 },
        })
      )
    })
  }

  if (Array.isArray(resumeJson.education) && resumeJson.education.length) {
    children.push(sectionTitle('Education'))
    resumeJson.education.forEach((edu) => {
      const headingParts = [edu.degree, edu.field].filter(Boolean).join(' · ')
      if (headingParts) {
        children.push(new Paragraph({ children: [new TextRun({ text: headingParts, bold: true })] }))
      }
      const lineParts = [edu.institution, [edu.startDate, edu.endDate].filter(Boolean).join(' - ')]
        .filter(Boolean)
        .join(' · ')
      if (lineParts) {
        children.push(new Paragraph({ children: [new TextRun({ text: lineParts, size: 20, color: '6B7280' })] }))
      }
    })
  }

  if (Array.isArray(resumeJson.certificates) && resumeJson.certificates.length) {
    children.push(sectionTitle('Certificates'))
    resumeJson.certificates.forEach((cert) => {
      const headingParts = [cert.name, cert.issuer].filter(Boolean).join(' · ')
      if (headingParts) {
        children.push(new Paragraph({ children: [new TextRun({ text: headingParts, bold: true })] }))
      }
      if (cert.year) {
        children.push(new Paragraph({ children: [new TextRun({ text: cert.year, size: 20, color: '6B7280' })] }))
      }
    })
  }

  const doc = new Document({
    sections: [{ children }],
  })

  return Packer.toBuffer(doc)
}

const generateResumePdf = async (resumeJson) => {
  const html = generateResumeHtml(resumeJson)
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '24mm', right: '18mm', bottom: '24mm', left: '18mm' },
    })
    return pdfBuffer
  } finally {
    await browser.close()
  }
}

const resumeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'basics',
    'summary',
    'skills',
    'experience',
    'projects',
    'education',
    'certificates',
  ],
  properties: {
    basics: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio'],
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        location: { type: 'string' },
        linkedin: { type: 'string' },
        github: { type: 'string' },
        portfolio: { type: 'string' },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'text'],
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
      },
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: { type: 'string' },
        properties: {
          id: { type: 'string' },
        },
      },
    },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['company', 'role', 'location', 'startDate', 'endDate', 'isCurrent', 'points'],
        properties: {
          company: { type: 'string' },
          role: { type: 'string' },
          location: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          isCurrent: { type: 'string' },
          points: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'text'],
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'technologies', 'link', 'points'],
        properties: {
          name: { type: 'string' },
          technologies: { type: 'string' },
          link: { type: 'string' },
          points: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'text'],
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['institution', 'degree', 'field', 'startDate', 'endDate'],
        properties: {
          institution: { type: 'string' },
          degree: { type: 'string' },
          field: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
        },
      },
    },
    certificates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'issuer', 'year'],
        properties: {
          name: { type: 'string' },
          issuer: { type: 'string' },
          year: { type: 'string' },
        },
      },
    },
  },
}

const extractJsonFromResponse = (response) => {
  if (response?.output_text) return response.output_text

  const message = response?.output?.find((item) => item.type === 'message')
  const content = message?.content?.find((item) => item.type === 'output_text')
  return content?.text || ''
}

const parseResumeWithLLM = async ({ resumeText }) => {
  const client = getOpenAIClient()
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content:
          `You are a resume parser.
          Return ONLY valid JSON. Do not Fill that is not there in the resume. 
          Parse the resume into this exact structure:
          \n{\n  \"basics\": {\"name\":\"\",\"email\":\"\",\"phone\":\"\",\"location\":\"\",\"linkedin\":\"\",\"github\":\"\",\"portfolio\":\"\"},\n  
          \"summary\": {\"id\":\"summary-1\",\"text\":\"\"},\n  \"skills\":[{\"id\":\"skill-1\",\"Languages\":\"python, Java\"}],\n  
          \"experience\":[{\"company\":\"\",\"role\":\"\",\"location\":\"\",\"startDate\":\"\",\"endDate\":\"\",\"isCurrent\":\"\",\"points\":[{\"id\":\"exp-1-1\",\"text\":\"\"}]}],\n  
          \"projects\":[{\"name\":\"\",\"technologies\":\"\",\"link\":\"\",\"points\":[{\"id\":\"proj-1-1\",\"text\":\"\"}]}],\n  
          \"education\":[{\"institution\":\"\",\"degree\":\"\",\"field\":\"\",\"startDate\":\"\",\"endDate\":\"\"}],\n  
          \"certificates\":[{\"name\":\"\",\"issuer\":\"\",\"year\":\"\"}]\n}\n 
          Extract only what is present in the resume. do not summarise experience and project points, parse them as it is in the resume.
          Use empty strings or empty arrays when data is missing. 
          Skills section can be more than what is there in the structure, it can be dynamically parsed depending on the resume.
          Generate stable ids: skills use \"skill-<n>\", experience points use \"exp-<jobIndex>-<pointIndex>\", project points use \"proj-<projectIndex>-<pointIndex>\" (1-based).`,
      },
      {
        role: 'user',
        content: `Resume Text:\\n${resumeText}`,
      },
    ],
    text: {
      format: {
        type: 'json_object',
      },
    },
  })

  const outputText = extractJsonFromResponse(response)
  if (!outputText) {
    throw new Error('No JSON received from LLM.')
  }

  return JSON.parse(outputText)
}

const optimizeSkillsWithLLM = async ({ resumeJson, jobDescription }) => {
  const client = getOpenAIClient()
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content:
          `You are a resume skills optimizer. Return ONLY valid JSON. 
          Use resumeJson and the job description to produce:
          {\n  
          \"Required Keywords\": [\"\"],\n  
          \"Matching Keywords\": [\"\"],\n  
          \"Missing Keywords\": [\"\"],\n  
          \"skills\": [{\"id\":\"skill-1\",\"skill1(Languages)\":\"python, Java\"}]\n}\n
          Rules: Required Keywords must come from the job description. 
          Matching Keywords are required keywords found in resumeJson. Missing Keywords are required keywords not found. 
          Update the skills section by adding missing tools/technologies from the JD. Keep the same skills if no changes are needed. 
          Preserve existing skill ids from resumeJson. If you add a new skill entry, generate a new unique id with the prefix \"skill-\".
          Use empty arrays if missing.
          `,
      },
      {
        role: 'user',
        content: `Resume JSON:\\n${JSON.stringify(resumeJson)}\\n\\nJob Description:\\n${jobDescription}`,
      },
    ],
    text: {
      format: {
        type: 'json_object',
      },
    },
  })

  const outputText = extractJsonFromResponse(response)
  if (!outputText) {
    throw new Error('No JSON received from LLM.')
  }

  return JSON.parse(outputText)
}

const optimizePointsWithLLM = async ({ resumeJson, jobDescription, skillsResult }) => {
  const client = getOpenAIClient()
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content:
          `You are a resume experience/projects optimizer. Return ONLY valid JSON.
          Using resumeJson(current resume), job description, and skillsResult, update ONLY experience points and project points to align with required skills using skills result.
          Output format:
          {\n  
          \"Analysis\": [\"\"],\n  
          \"experience\": [{\"company\":\"\",\"role\":\"\",\"location\":\"\",\"startDate\":\"\",\"endDate\":\"\",\"isCurrent\":\"\",\"points\":[{\"id\":\"exp-1-1\",\"text\":\"\"}]}],\n  
          \"projects\": [{\"name\":\"\",\"technologies\":\"\",\"link\":\"\",\"points\":[{\"id\":\"proj-1-1\",\"text\":\"\"}]}]\n}\n
          Rules: Analysis should be 3-6 high-level improvement notes. 
          Rewrite bullets to include relevant skills/keywords and measurable impact when possible.
          Keep the SAME number of points and the SAME order for each experience/project entry. 
          Only rewrite the text of a point in place; do NOT reorder, add, or delete points.
          Preserve the point ids from resumeJson; do not change ids.
          Make changes to at least half of the points to match the resume and make it pass ATS resume screening for this job description.
          `,
      },
      {
        role: 'user',
        content: `Resume JSON:\\n${JSON.stringify(resumeJson)}\\n\\nSkills Result:\\n${JSON.stringify(skillsResult)}\\n\\nJob Description:\\n${jobDescription}`,
      },
    ],
    text: {
      format: {
        type: 'json_object',
      },
    },
  })

  const outputText = extractJsonFromResponse(response)
  if (!outputText) {
    throw new Error('No JSON received from LLM.')
  }

  return JSON.parse(outputText)
}

const optimizeSummaryWithLLM = async ({ resumeJson, jobDescription, skillsResult, pointsResult }) => {
  const client = getOpenAIClient()
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content:
          `You are a resume summary optimizer. Return ONLY valid JSON.
          Using resumeJson, job description, skillsResult, and pointsResult, write a new summary aligned to the target role.
          Output format:
          {\n  \"summary\": {\"id\":\"summary-1\",\"text\":\"\"}\n}\n
          Rules: Keep it 2-4 lines, include key skills and impact. Preserve the summary id from resumeJson.`,
      },
      {
        role: 'user',
        content: `Resume JSON:\\n${JSON.stringify(resumeJson)}\\n\\nSkills Result:\\n${JSON.stringify(
          skillsResult
        )}\\n\\nPoints Result:\\n${JSON.stringify(pointsResult)}\\n\\nJob Description:\\n${jobDescription}`,
      },
    ],
    text: {
      format: {
        type: 'json_object',
      },
    },
  })

  const outputText = extractJsonFromResponse(response)
  if (!outputText) {
    throw new Error('No JSON received from LLM.')
  }

  return JSON.parse(outputText)
}

const getFieldValue = (value) => {
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : ''
}

const parseResumeFile = async (file) => {
  const ext = path.extname(file.originalname).toLowerCase()
  const mime = file.mimetype

  if (mime === 'application/pdf' || ext === '.pdf') {
    const parsed = await pdfParse(file.buffer)
    return { text: parsed.text, source: 'pdf' }
  }

  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer })
    return { text: result.value, source: 'docx' }
  }

  if (mime === 'text/plain' || ext === '.txt') {
    return { text: file.buffer.toString('utf8'), source: 'txt' }
  }

  throw new Error('Unsupported file type. Upload PDF, DOCX, or TXT.')
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.post('/api/analyze', parseMultipart, async (req, res, next) => {
  try {
    const resumeTextField = getFieldValue(req.body?.resumeText)
    const jobDescription = getFieldValue(req.body?.jobDescription)

    if (!jobDescription || jobDescription.trim().length < 80) {
      return res.status(400).json({ error: 'jobDescription must be at least 80 characters' })
    }

    let resumeText = resumeTextField.trim()
    let source = resumeText ? 'text' : 'file'

    if (!resumeText && req.file) {
      const parsed = await parseResumeFile(req.file)
      resumeText = parsed.text.trim()
      source = parsed.source
    }

    if (!resumeText) {
      return res.status(400).json({ error: 'Provide resume text or upload a resume file.' })
    }

    const parsedResume = await parseResumeWithLLM({ resumeText })
    const resumeJson = normalizeResumeJson(parsedResume)

    const skillsResult = await optimizeSkillsWithLLM({ resumeJson, jobDescription })
    const pointsResult = await optimizePointsWithLLM({ resumeJson, jobDescription, skillsResult })
    const summaryResult = await optimizeSummaryWithLLM({ resumeJson, jobDescription, skillsResult, pointsResult })

    const combined = {
      'Required Keywords': skillsResult?.['Required Keywords'],
      'Matching Keywords': skillsResult?.['Matching Keywords'],
      'Missing Keywords': skillsResult?.['Missing Keywords'],
      Analysis: pointsResult?.Analysis,
      summary: summaryResult?.summary,
      skills: skillsResult?.skills,
      experience: pointsResult?.experience,
      projects: pointsResult?.projects,
      education: resumeJson.education,
      certificates: resumeJson.certificates,
    }

    const analysisJson = normalizeAnalysisJson(combined, resumeJson)

    await saveLlmResult({ resumeJson, skillsResult, pointsResult, summaryResult, analysisJson })

    const requiredSkills = normalizeList(analysisJson['Required Keywords'])
    const matchedSkills = normalizeList(analysisJson['Matching Keywords']).filter((skill) =>
      requiredSkills.length ? requiredSkills.includes(skill) : true
    )
    const llmMissing = normalizeList(analysisJson['Missing Keywords'])
    const missingSkills =
      llmMissing.length > 0 ? llmMissing : requiredSkills.filter((skill) => !matchedSkills.includes(skill))

    const rawScore = requiredSkills.length ? Math.round((matchedSkills.length / requiredSkills.length) * 100) : 72
    const matchScore = Math.max(45, Math.min(98, rawScore))

    const analysis = {
      roleTitle: detectRoleTitle(jobDescription),
      requiredSkills,
      matchedSkills,
      missingSkills,
      issues: Array.isArray(analysisJson.Analysis) ? analysisJson.Analysis : [],
      rewriteSuggestions: [],
      summaryAfter: analysisJson.summary?.text || '',
      matchScore,
      atsGrade: gradeFromScore(matchScore),
    }

    const buildSkillsText = (skills) =>
      Array.isArray(skills)
        ? skills
            .map((entry) => {
              const { label, value } = extractSkillLabelValue(entry)
              if (!label && !value) return ''
              return value ? `${label}: ${value}` : label
            })
            .filter(Boolean)
            .join(' · ')
        : ''

    if (resumeJson.summary?.text && analysisJson.summary?.text && resumeJson.summary.text !== analysisJson.summary.text) {
      analysis.rewriteSuggestions.push({
        id: 'summary',
        title: 'Summary',
        before: resumeJson.summary.text,
        after: analysisJson.summary.text,
      })
    }

    const resumeSkillsText = buildSkillsText(resumeJson.skills)
    const analysisSkillsText = buildSkillsText(analysisJson.skills)
    if (resumeSkillsText && analysisSkillsText && resumeSkillsText !== analysisSkillsText) {
      analysis.rewriteSuggestions.push({
        id: 'skills',
        title: 'Skills',
        before: resumeSkillsText,
        after: analysisSkillsText,
      })
    }

    return res.json({
      success: true,
      analysis,
      resumeText,
      resumeJson,
      analysisJson,
      source,
    })
  } catch (err) {
    next(err)
  }
})

app.post('/api/export-pdf', async (req, res, next) => {
  try {
    const incoming = req.body?.resumeJson || req.body
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'resumeJson is required.' })
    }

    const resumeJson = normalizeResumeJson(incoming)
    const pdfBuffer = await generateResumePdf(resumeJson)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="Updated_Resume.pdf"')
    res.setHeader('Content-Length', pdfBuffer.length)
    return res.send(pdfBuffer)
  } catch (err) {
    return next(err)
  }
})

app.post('/api/export-docx', async (req, res, next) => {
  try {
    const incoming = req.body?.resumeJson || req.body
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'resumeJson is required.' })
    }

    const resumeJson = normalizeResumeJson(incoming)
    const docxBuffer = await generateResumeDocxBuffer(resumeJson)

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    res.setHeader('Content-Disposition', 'attachment; filename="Updated_Resume.docx"')
    res.setHeader('Content-Length', docxBuffer.length)
    return res.send(docxBuffer)
  } catch (err) {
    return next(err)
  }
})

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message })
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Request failed.' })
  }
  return res.status(500).json({ error: 'Unexpected server error.' })
})

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`)
})
