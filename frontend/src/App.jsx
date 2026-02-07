import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

const sampleResume = `John Smith\nAustin, TX · john.smith@email.com · (512) 555-0191\n\nProfessional Summary\nProduct-focused engineer with 6+ years of experience building web applications and collaborating with design teams.\n\nExperience\nSenior Front-End Engineer, Harbor Labs\n- Built reusable UI components in React for a design system used by 5 product teams.\n- Partnered with product to launch new onboarding flows and reduce churn.\n\nProjects\n- Developed internal tooling for QA automation and release readiness.\n\nSkills\nJavaScript, React, CSS, HTML, Figma, Jira`

const steps = [
  {
    id: 1,
    label: 'Upload',
    title: 'Upload Resume & Job Description',
    description: 'Upload your resume and add a job description to start the analysis.',
  },
  {
    id: 2,
    label: 'Analyze',
    title: 'Analyzing Match Score',
    description: 'Parsing resume, job description, and ATS alignment.',
  },
  {
    id: 3,
    label: 'Results',
    title: 'Review Match Results & Fix Gaps',
    description: 'Compare resume vs optimized version and apply changes.',
  },
  {
    id: 4,
    label: 'Export',
    title: 'Export Updated Resume',
    description: 'Download the polished resume in DOCX format.',
  },
]

const formatBytes = (bytes = 0) => {
  if (!bytes) return '0 KB'
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1)
  return `${(bytes / 1024 ** i).toFixed(1)} ${sizes[i]}`
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

const skillEntryToText = (entry) => {
  const { label, value } = extractSkillLabelValue(entry)
  if (!label && !value) return ''
  return value ? `${label}: ${value}` : label
}

const skillEntryLabel = (entry) => {
  const { label } = extractSkillLabelValue(entry)
  return label || ''
}

const skillsToText = (skills = []) =>
  (Array.isArray(skills) ? skills : [])
    .map((entry) => skillEntryToText(entry))
    .filter(Boolean)
    .join(' · ')

const getSummaryText = (summary) => (typeof summary === 'string' ? summary : summary?.text || '')
const getSummaryId = (summary) => (summary && typeof summary === 'object' && summary.id ? summary.id : 'summary-1')

const getPointText = (point) => {
  if (typeof point === 'string') return point
  if (point && typeof point === 'object') {
    if (typeof point.text === 'string') return point.text
    if (typeof point.value === 'string') return point.value
  }
  return ''
}

const getPointId = (point, fallbackId) => {
  if (point && typeof point === 'object' && typeof point.id === 'string' && point.id) return point.id
  return fallbackId
}

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const diffWords = (beforeText = '', afterText = '') => {
  const beforeWords = beforeText.split(/\s+/).filter(Boolean)
  const afterWords = afterText.split(/\s+/).filter(Boolean)

  const rows = beforeWords.length + 1
  const cols = afterWords.length + 1
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0))

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (beforeWords[i - 1] === afterWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const operations = []
  let i = beforeWords.length
  let j = afterWords.length
  while (i > 0 && j > 0) {
    if (beforeWords[i - 1] === afterWords[j - 1]) {
      operations.unshift({ type: 'equal', value: beforeWords[i - 1] })
      i -= 1
      j -= 1
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      operations.unshift({ type: 'remove', value: beforeWords[i - 1] })
      i -= 1
    } else {
      operations.unshift({ type: 'add', value: afterWords[j - 1] })
      j -= 1
    }
  }
  while (i > 0) {
    operations.unshift({ type: 'remove', value: beforeWords[i - 1] })
    i -= 1
  }
  while (j > 0) {
    operations.unshift({ type: 'add', value: afterWords[j - 1] })
    j -= 1
  }

  const beforeHtml = operations
    .filter((op) => op.type !== 'add')
    .map((op) => {
      const klass = op.type === 'remove' ? 'diff-removed' : 'diff-unchanged'
      return `<span class="${klass}">${escapeHtml(op.value)}</span>`
    })
    .join(' ')

  const afterHtml = operations
    .filter((op) => op.type !== 'remove')
    .map((op) => {
      const klass = op.type === 'add' ? 'diff-added' : 'diff-unchanged'
      return `<span class="${klass}">${escapeHtml(op.value)}</span>`
    })
    .join(' ')

  return {
    beforeHtml,
    afterHtml,
  }
}

const buildChangeItems = (resumeJson, analysisJson) => {
  if (!resumeJson || !analysisJson) return []

  const items = []

  const summaryBefore = getSummaryText(resumeJson.summary)
  const summaryAfter = getSummaryText(analysisJson.summary)
  if (summaryAfter && summaryAfter !== summaryBefore) {
    const summaryId = getSummaryId(analysisJson.summary) || getSummaryId(resumeJson.summary)
    items.push({
      id: `summary:${summaryId}`,
      type: 'summary',
      title: 'Summary',
      before: summaryBefore,
      after: summaryAfter,
      summaryId,
    })
  }

  const resumeSkills = Array.isArray(resumeJson.skills) ? resumeJson.skills : []
  const analysisSkills = Array.isArray(analysisJson.skills) ? analysisJson.skills : []
  const resumeSkillMap = new Map()
  resumeSkills.forEach((entry, index) => {
    const id = (entry && entry.id) || `skill-${index + 1}`
    resumeSkillMap.set(id, { entry, index })
  })
  const analysisSkillMap = new Map()
  analysisSkills.forEach((entry, index) => {
    const id = (entry && entry.id) || `skill-${index + 1}`
    analysisSkillMap.set(id, { entry, index })
  })
  const orderedSkillIds = [
    ...resumeSkillMap.keys(),
    ...Array.from(analysisSkillMap.keys()).filter((id) => !resumeSkillMap.has(id)),
  ]

  orderedSkillIds.forEach((skillId, idx) => {
    const beforeEntry = resumeSkillMap.get(skillId)?.entry || null
    const afterEntry = analysisSkillMap.get(skillId)?.entry || null
    const beforeText = skillEntryToText(beforeEntry)
    const afterText = skillEntryToText(afterEntry)
    if (!beforeText && !afterText) return
    if (beforeText === afterText) return
    const label = skillEntryLabel(afterEntry) || skillEntryLabel(beforeEntry) || `Skill ${idx + 1}`
    items.push({
      id: `skill:${skillId}`,
      type: 'skill',
      title: label,
      skillId,
      before: beforeText,
      after: afterText,
    })
  })

  const resumeExperience = resumeJson.experience || []
  const analysisExperience = analysisJson.experience || []
  const maxJobs = Math.max(resumeExperience.length, analysisExperience.length)
  for (let jobIndex = 0; jobIndex < maxJobs; jobIndex += 1) {
    const resumeJob = resumeExperience[jobIndex] || {}
    const analysisJob = analysisExperience[jobIndex] || {}
    const labelParts = [analysisJob.role || resumeJob.role, analysisJob.company || resumeJob.company]
      .filter(Boolean)
      .join(' · ')
    const group = labelParts || `Experience ${jobIndex + 1}`

    const resumePoints = Array.isArray(resumeJob.points) ? resumeJob.points : []
    const analysisPoints = Array.isArray(analysisJob.points) ? analysisJob.points : []
    const resumePointMap = new Map()
    resumePoints.forEach((point, index) => {
      const id = getPointId(point, `exp-${jobIndex + 1}-${index + 1}`)
      resumePointMap.set(id, { point, index })
    })
    const analysisPointMap = new Map()
    analysisPoints.forEach((point, index) => {
      const id = getPointId(point, `exp-${jobIndex + 1}-${index + 1}`)
      analysisPointMap.set(id, { point, index })
    })
    const orderedPointIds = [
      ...resumePointMap.keys(),
      ...Array.from(analysisPointMap.keys()).filter((id) => !resumePointMap.has(id)),
    ]
    orderedPointIds.forEach((pointId) => {
      const before = getPointText(resumePointMap.get(pointId)?.point)
      const after = getPointText(analysisPointMap.get(pointId)?.point)
      if (!before && !after) return
      if (before === after) return
      items.push({
        id: `exp:${jobIndex}:${pointId}`,
        type: 'experience',
        group,
        jobIndex,
        pointId,
        before,
        after,
      })
    })
  }

  const resumeProjects = resumeJson.projects || []
  const analysisProjects = analysisJson.projects || []
  const maxProjects = Math.max(resumeProjects.length, analysisProjects.length)
  for (let projectIndex = 0; projectIndex < maxProjects; projectIndex += 1) {
    const resumeProject = resumeProjects[projectIndex] || {}
    const analysisProject = analysisProjects[projectIndex] || {}
    const group = analysisProject.name || resumeProject.name || `Project ${projectIndex + 1}`

    const resumePoints = Array.isArray(resumeProject.points) ? resumeProject.points : []
    const analysisPoints = Array.isArray(analysisProject.points) ? analysisProject.points : []
    const resumePointMap = new Map()
    resumePoints.forEach((point, index) => {
      const id = getPointId(point, `proj-${projectIndex + 1}-${index + 1}`)
      resumePointMap.set(id, { point, index })
    })
    const analysisPointMap = new Map()
    analysisPoints.forEach((point, index) => {
      const id = getPointId(point, `proj-${projectIndex + 1}-${index + 1}`)
      analysisPointMap.set(id, { point, index })
    })
    const orderedPointIds = [
      ...resumePointMap.keys(),
      ...Array.from(analysisPointMap.keys()).filter((id) => !resumePointMap.has(id)),
    ]
    orderedPointIds.forEach((pointId) => {
      const before = getPointText(resumePointMap.get(pointId)?.point)
      const after = getPointText(analysisPointMap.get(pointId)?.point)
      if (!before && !after) return
      if (before === after) return
      items.push({
        id: `proj:${projectIndex}:${pointId}`,
        type: 'project',
        group,
        projectIndex,
        pointId,
        before,
        after,
      })
    })
  }

  return items
}

const buildInitialChangeState = (items) =>
  items.reduce((acc, item) => {
    acc[item.id] = false
    return acc
  }, {})

const buildUpdatedResumeData = (resumeJson, analysisJson, changeItems, changeState) => {
  if (!resumeJson) return null

  const clonePoints = (points) =>
    Array.isArray(points)
      ? points.map((point) => (point && typeof point === 'object' ? { ...point } : point))
      : []
  const cloneJobs = (items) =>
    Array.isArray(items) ? items.map((item) => ({ ...item, points: clonePoints(item.points) })) : []

  const updated = {
    ...resumeJson,
    basics: { ...(resumeJson.basics || {}) },
    summary: resumeJson.summary && typeof resumeJson.summary === 'object' ? { ...resumeJson.summary } : resumeJson.summary,
    skills: Array.isArray(resumeJson.skills) ? [...resumeJson.skills] : [],
    experience: cloneJobs(resumeJson.experience),
    projects: cloneJobs(resumeJson.projects),
    education: Array.isArray(resumeJson.education) ? resumeJson.education.map((item) => ({ ...item })) : [],
    certificates: Array.isArray(resumeJson.certificates)
      ? resumeJson.certificates.map((item) => ({ ...item }))
      : [],
  }

  if (!analysisJson) return updated

  changeItems.forEach((item) => {
    if (!changeState[item.id]) return

    if (item.type === 'summary') {
      updated.summary = analysisJson.summary && typeof analysisJson.summary === 'object'
        ? { ...analysisJson.summary }
        : analysisJson.summary || updated.summary
    }

    if (item.type === 'skill') {
      const analysisSkill = Array.isArray(analysisJson.skills)
        ? analysisJson.skills.find((entry) => (entry?.id || '') === item.skillId)
        : null
      const existingIndex = updated.skills.findIndex((entry) => (entry?.id || '') === item.skillId)
      if (analysisSkill && typeof analysisSkill === 'object' && Object.keys(analysisSkill).length) {
        if (existingIndex >= 0) {
          updated.skills[existingIndex] = analysisSkill
        } else {
          updated.skills.push(analysisSkill)
        }
      } else if (existingIndex >= 0) {
        updated.skills.splice(existingIndex, 1)
      }
    }

    if (item.type === 'experience') {
      const analysisJob = analysisJson.experience?.[item.jobIndex]
      if (!analysisJob) return
      while (updated.experience.length <= item.jobIndex) {
        updated.experience.push({ ...analysisJob, points: [] })
      }
      const job = updated.experience[item.jobIndex]
      if (!Array.isArray(job.points)) job.points = []
      const analysisPoints = Array.isArray(analysisJob.points) ? analysisJob.points : []
      const analysisPoint = analysisPoints.find((point) => getPointId(point, '') === item.pointId)
      if (!analysisPoint) return
      const nextPoint = { id: getPointId(analysisPoint, item.pointId), text: getPointText(analysisPoint) }
      const existingIndex = job.points.findIndex((point) => getPointId(point, '') === item.pointId)
      if (existingIndex >= 0) {
        job.points[existingIndex] = nextPoint
      } else {
        job.points.push(nextPoint)
      }
    }

    if (item.type === 'project') {
      const analysisProject = analysisJson.projects?.[item.projectIndex]
      if (!analysisProject) return
      while (updated.projects.length <= item.projectIndex) {
        updated.projects.push({ ...analysisProject, points: [] })
      }
      const project = updated.projects[item.projectIndex]
      if (!Array.isArray(project.points)) project.points = []
      const analysisPoints = Array.isArray(analysisProject.points) ? analysisProject.points : []
      const analysisPoint = analysisPoints.find((point) => getPointId(point, '') === item.pointId)
      if (!analysisPoint) return
      const nextPoint = { id: getPointId(analysisPoint, item.pointId), text: getPointText(analysisPoint) }
      const existingIndex = project.points.findIndex((point) => getPointId(point, '') === item.pointId)
      if (existingIndex >= 0) {
        project.points[existingIndex] = nextPoint
      } else {
        project.points.push(nextPoint)
      }
    }
  })

  updated.skills = updated.skills.filter((entry) => entry && typeof entry === 'object' && Object.keys(entry).length)

  return updated
}

const renderResumeText = (resumeData) => {
  if (!resumeData) return ''
  const lines = []
  const basics = resumeData.basics || {}
  const name = basics.name || 'Candidate'
  lines.push(name)

  const contactParts = [
    basics.location,
    basics.email,
    basics.phone,
    basics.linkedin,
    basics.github,
    basics.portfolio,
  ].filter(Boolean)
  if (contactParts.length) {
    lines.push(contactParts.join(' · '))
  }

  lines.push('', 'Summary')
  lines.push(getSummaryText(resumeData.summary) || '')

  lines.push('', 'Experience')
  ;(resumeData.experience || []).forEach((job) => {
    const headingParts = [job.role, job.company, job.location].filter(Boolean)
    if (headingParts.length) {
      lines.push(headingParts.join(' · '))
    }
    const dateParts = [job.startDate, job.endDate || (job.isCurrent ? 'Present' : '')].filter(Boolean)
    if (dateParts.length) {
      lines.push(dateParts.join(' - '))
    }
    ;(job.points || [])
      .filter((point) => getPointText(point))
      .forEach((point) => lines.push(`- ${getPointText(point)}`))
    lines.push('')
  })

  lines.push('Projects')
  ;(resumeData.projects || []).forEach((project) => {
    const headingParts = [project.name, project.technologies].filter(Boolean)
    if (headingParts.length) {
      lines.push(headingParts.join(' · '))
    }
    if (project.link) lines.push(project.link)
    ;(project.points || [])
      .filter((point) => getPointText(point))
      .forEach((point) => lines.push(`- ${getPointText(point)}`))
    lines.push('')
  })

  lines.push('Skills')
  lines.push(skillsToText(resumeData.skills) || '')

  return lines.join('\n').trim()
}

const groupBy = (items, key) =>
  items.reduce((acc, item) => {
    const groupKey = item[key] || 'Other'
    if (!acc[groupKey]) acc[groupKey] = []
    acc[groupKey].push(item)
    return acc
  }, {})

const downloadFromUrl = (url, filename) => {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
}

function App() {
  const [currentStep, setCurrentStep] = useState(1)
  const [resumeFile, setResumeFile] = useState(null)
  const [resumeText, setResumeText] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [resumeNote, setResumeNote] = useState('')
  const [analysis, setAnalysis] = useState(null)
  const [resumeJson, setResumeJson] = useState(null)
  const [analysisJson, setAnalysisJson] = useState(null)
  const [changeItems, setChangeItems] = useState([])
  const [changeState, setChangeState] = useState({})
  const [analysisProgress, setAnalysisProgress] = useState(0)
  const [analysisStage, setAnalysisStage] = useState('Parsing resume')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [error, setError] = useState('')
  const [exportDocxUrl, setExportDocxUrl] = useState('')
  const [exportingDocx, setExportingDocx] = useState(false)
  const [exportError, setExportError] = useState('')

  const timerRef = useRef(null)
  const abortRef = useRef(null)
  const exportDocxAbortRef = useRef(null)
  const exportUrlRef = useRef('')

  const activeStep = steps.find((step) => step.id === currentStep)
  const appliedCount = Object.values(changeState).filter(Boolean).length
  const improvedScore = analysis
    ? Math.min(99, Math.round(analysis.matchScore + appliedCount * 2 + (analysis.missingSkills.length ? 0 : 2)))
    : null
  const displayScore = analysis ? (currentStep >= 3 ? improvedScore : analysis.matchScore) : null
  const scoreDelta = analysis ? Math.max(0, improvedScore - analysis.matchScore) : 0

  const updatedResumeData = useMemo(
    () => buildUpdatedResumeData(resumeJson, analysisJson, changeItems, changeState),
    [resumeJson, analysisJson, changeItems, changeState]
  )

  const resumePreview = useMemo(() => {
    if (!updatedResumeData) return ''
    const text = renderResumeText(updatedResumeData)
    return text.split(/\n/).slice(0, 18).join('\n')
  }, [updatedResumeData])

  const resumeDocText = useMemo(() => {
    if (!updatedResumeData) return ''
    return renderResumeText(updatedResumeData)
  }, [updatedResumeData])

  const summaryChange = changeItems.find((item) => item.type === 'summary')
  const skillChanges = changeItems.filter((item) => item.type === 'skill')
  const experienceChanges = changeItems.filter((item) => item.type === 'experience')
  const projectChanges = changeItems.filter((item) => item.type === 'project')

  const experienceGroups = useMemo(() => groupBy(experienceChanges, 'group'), [experienceChanges])
  const projectGroups = useMemo(() => groupBy(projectChanges, 'group'), [projectChanges])

  useEffect(() => {
    exportUrlRef.current = exportDocxUrl
  }, [exportDocxUrl])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
      }
      if (abortRef.current) {
        abortRef.current.abort()
      }
      if (exportDocxAbortRef.current) {
        exportDocxAbortRef.current.abort()
      }
      if (exportUrlRef.current) {
        URL.revokeObjectURL(exportUrlRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (exportDocxAbortRef.current) {
      exportDocxAbortRef.current.abort()
      exportDocxAbortRef.current = null
    }
    setExportingDocx(false)
    setExportDocxUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return ''
    })
    setExportError('')
  }, [changeState, resumeJson, analysisJson])

  const maxStep = analysis ? 4 : currentStep

  const stopProgress = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const resetAnalysis = () => {
    if (!analysis) return
    setAnalysis(null)
    setResumeJson(null)
    setAnalysisJson(null)
    setChangeItems([])
    setChangeState({})
    setExportDocxUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return ''
    })
    setExportError('')
    setExportingDocx(false)
    setCurrentStep(1)
  }

  const handleResumeUpload = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setResumeFile(file)
    setResumeNote('')
    setError('')
    resetAnalysis()

    if (file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')) {
      const reader = new FileReader()
      reader.onload = (e) => {
        setResumeText(e.target?.result?.toString() ?? '')
        setResumeNote('Extracted text from your file.')
      }
      reader.readAsText(file)
    } else {
      setResumeText('')
      setResumeNote('File uploaded. It will be parsed on the server during analysis.')
    }
  }

  const handleResumeTextChange = (value) => {
    setResumeText(value)
    setResumeNote(value ? 'Using pasted resume text for analysis.' : '')
    setError('')
    resetAnalysis()
  }

  const handleJobDescriptionChange = (value) => {
    setJobDescription(value)
    setError('')
    resetAnalysis()
  }

  const canAnalyze =
    (resumeText.trim().length > 0 || resumeFile) && jobDescription.trim().length >= 80 && !isAnalyzing

  const startProgressTicker = () => {
    stopProgress()
    timerRef.current = setInterval(() => {
      setAnalysisProgress((prev) => {
        const increment = Math.floor(Math.random() * 8) + 6
        const next = Math.min(prev + increment, 88)
        if (next < 35) setAnalysisStage('Parsing resume')
        else if (next < 65) setAnalysisStage('Extracting skills')
        else setAnalysisStage('Scoring match')
        return next
      })
    }, 350)
  }

  const startAnalysis = async () => {
    if (!resumeText.trim() && !resumeFile) {
      setError('Upload a resume file or paste resume text to continue.')
      return
    }
    if (jobDescription.trim().length < 80) {
      setError('Paste a full job description (at least 80 characters).')
      return
    }

    setError('')
    setCurrentStep(2)
    setIsAnalyzing(true)
    setAnalysisProgress(0)
    setAnalysisStage('Parsing resume')
    startProgressTicker()

    if (abortRef.current) {
      abortRef.current.abort()
    }
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const formData = new FormData()
      if (resumeFile) formData.append('resumeFile', resumeFile)
      if (resumeText.trim()) formData.append('resumeText', resumeText.trim())
      formData.append('jobDescription', jobDescription.trim())

      const response = await fetch(`${API_BASE}/api/analyze`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(data.error || 'Analysis failed. Please try again.')
      }

      if (!data.analysis) {
        throw new Error('Invalid analysis response from server.')
      }

      stopProgress()
      setAnalysisStage('Finalizing results')
      setAnalysisProgress(100)

      const incomingResumeJson = data.resumeJson || null
      const incomingAnalysisJson = data.analysisJson || null
      const items = buildChangeItems(incomingResumeJson, incomingAnalysisJson)

      setAnalysis({ ...data.analysis, resumeText: data.resumeText || '' })
      setResumeJson(incomingResumeJson)
      setAnalysisJson(incomingAnalysisJson)
      setChangeItems(items)
      setChangeState(buildInitialChangeState(items))

      setIsAnalyzing(false)
      setCurrentStep(3)
    } catch (err) {
      if (err.name === 'AbortError') {
        return
      }
      stopProgress()
      setIsAnalyzing(false)
      setAnalysisProgress(0)
      setCurrentStep(1)
      setError(err.message || 'Unable to reach the backend.')
    } finally {
      abortRef.current = null
    }
  }

  const cancelAnalysis = () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    stopProgress()
    setIsAnalyzing(false)
    setAnalysisProgress(0)
    setCurrentStep(1)
  }

  const toggleChange = (id) => {
    setChangeState((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const setAllChanges = (value) => {
    const nextState = changeItems.reduce((acc, item) => {
      acc[item.id] = value
      return acc
    }, {})
    setChangeState(nextState)
  }

  const requestDocxExport = async (resumeData) => {
    if (!resumeData) return
    if (exportDocxAbortRef.current) {
      exportDocxAbortRef.current.abort()
    }

    const controller = new AbortController()
    exportDocxAbortRef.current = controller
    setExportingDocx(true)
    setExportError('')

    try {
      const response = await fetch(`${API_BASE}/api/export-docx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeJson: resumeData }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Unable to export DOCX.')
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      setExportDocxUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return url
      })
      return url
    } catch (err) {
      if (err.name === 'AbortError') {
        return
      }
      setExportError(err.message || 'Unable to export DOCX.')
      return null
    } finally {
      setExportingDocx(false)
      exportDocxAbortRef.current = null
    }
  }

  const handleContinueToExport = () => {
    if (!updatedResumeData) return
    setCurrentStep(4)
    requestDocxExport(updatedResumeData)
  }

  const handleDownload = async () => {
    if (!analysis || !updatedResumeData) return
    let url = exportDocxUrl
    if (!url && !exportingDocx) {
      url = await requestDocxExport(updatedResumeData)
    }
    if (url) {
      downloadFromUrl(url, 'Updated_Resume.docx')
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            ▣
          </span>
          <div>
            <div className="brand-title">Resume Analyzer</div>
            <div className="brand-sub">AI-assisted resume matching</div>
          </div>
        </div>
      </header>

      <main>
        <section className="intro">
          <div>
            <h1>{activeStep.title}</h1>
            <p>{activeStep.description}</p>
          </div>
          <div className="match-score">
            <div>
              <div className="match-score__label">Current Match</div>
              <div className="match-score__value">{displayScore ? `${displayScore}%` : '--'}</div>
            </div>
            <div className="match-score__trend">
              {analysis ? `+${scoreDelta}% after fixes` : 'Upload to calculate'}
            </div>
          </div>
        </section>

        <section className="stepper" aria-label="Workflow steps">
          {steps.map((step) => {
            const isActive = step.id === currentStep
            const isDone = step.id < currentStep
            const isDisabled = step.id > maxStep || isAnalyzing
            return (
              <button
                key={step.id}
                className={`stepper-item${isActive ? ' stepper-item--active' : ''}${
                  isDone ? ' stepper-item--done' : ''
                }`}
                type="button"
                onClick={() => !isDisabled && setCurrentStep(step.id)}
                disabled={isDisabled}
              >
                <span className="stepper-index">{step.id}</span>
                <span>{step.label}</span>
              </button>
            )
          })}
        </section>

        <section className="stage">
          {currentStep === 1 && (
            <article className="panel">
              <header className="panel-header">
                <span className="step-badge">1</span>
                <div>
                  <h2>Upload Resume & Job Description</h2>
                  <p>Upload files or paste content to start the analysis.</p>
                </div>
              </header>

              <div className="panel-grid">
                <div className="panel-card panel-card--file panel-card--bright">
                  <div className="panel-card__header">Upload Your Resume</div>
                  <label className="file-input">
                    <input type="file" accept=".pdf,.docx,.txt" onChange={handleResumeUpload} />
                    <div className="file-input__title">
                      {resumeFile ? 'Replace resume file' : 'Click to upload resume'}
                    </div>
                    <div className="file-input__meta">PDF, DOCX, or TXT · Max 10 MB</div>
                  </label>

                  {resumeFile ? (
                    <div className="file-preview">
                      <div className="file-icon">{resumeFile.name.split('.').pop()?.toUpperCase()}</div>
                      <div>
                        <div className="file-name">{resumeFile.name}</div>
                        <div className="file-meta">
                          {formatBytes(resumeFile.size)} · {resumeFile.type || 'Unknown format'}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="file-placeholder">No resume uploaded yet.</div>
                  )}

                  <div className="field">
                    <label htmlFor="resume-text">Resume text (optional if uploading a file)</label>
                    <textarea
                      id="resume-text"
                      value={resumeText}
                      onChange={(event) => handleResumeTextChange(event.target.value)}
                      placeholder="Paste resume text for analysis (optional if you uploaded a file)."
                    />
                  </div>

                  <div className="panel-actions">
                    <button className="btn btn-ghost" type="button" onClick={() => handleResumeTextChange('')}>
                      Clear text
                    </button>
                  </div>

                  {resumeNote && <div className="helper-text">{resumeNote}</div>}
                </div>

                <div className="panel-card panel-card--bright">
                  <div className="panel-card__header">Paste Job Description</div>
                  <div className="field">
                    <label htmlFor="jd-text">Job description</label>
                    <textarea
                      id="jd-text"
                      value={jobDescription}
                      onChange={(event) => handleJobDescriptionChange(event.target.value)}
                      placeholder="Paste the job description here. Include responsibilities and requirements."
                    />
                  </div>
                  <div className="panel-actions">
                    <button className="btn btn-ghost" type="button" onClick={() => handleJobDescriptionChange('')}>
                      Clear JD
                    </button>
                  </div>
                  <div className="helper-text">Minimum length: 80 characters.</div>
                </div>
              </div>

              {error && <div className="alert">{error}</div>}

              <div className="panel-footer">
                <div className="panel-footer__group">
                </div>
                <div className="panel-footer__group">
                  <button className="btn btn-primary" type="button" onClick={startAnalysis} disabled={!canAnalyze}>
                    Analyze Match
                  </button>
                </div>
              </div>
            </article>
          )}

          {currentStep === 2 && (
            <article className="panel">
              <header className="panel-header">
                <span className="step-badge">2</span>
                <div>
                  <h2>Analyzing Match Score</h2>
                  <p>Parsing resume, job description, and ATS alignment.</p>
                </div>
              </header>

              <div className="analysis">
                <div
                  className="progress-ring"
                  role="img"
                  aria-label={`Match progress ${analysisProgress} percent`}
                  style={{ '--progress': `${analysisProgress}%` }}
                />
                <div className="analysis-copy">
                  <h3>{analysisStage}…</h3>
                  <p>We are extracting skills, experience signals, and impact metrics.</p>
                </div>
              </div>

              <div className="progress-bar">
                <div className="progress-bar__fill" style={{ width: `${analysisProgress}%` }} />
                <span className="progress-bar__label">
                  {analysisStage} · {analysisProgress}%
                </span>
              </div>

              <div className="panel-footer">
                <div className="panel-footer__group">
                  <button className="btn btn-ghost" type="button" onClick={cancelAnalysis}>
                    Cancel
                  </button>
                </div>
                <div className="panel-footer__group">
                  <button className="btn btn-primary" type="button" onClick={() => setCurrentStep(3)} disabled={isAnalyzing}>
                    View Results
                  </button>
                </div>
              </div>
            </article>
          )}

          {currentStep === 3 && analysis && (
            <article className="panel">
              <header className="panel-header">
                <span className="step-badge">3</span>
                <div>
                  <h2>Review Match Results & Fix Gaps</h2>
                  <p>Compare resume vs optimized version and apply changes.</p>
                </div>
              </header>

              <div className="panel-grid">
                <div className="panel-card">
                  <div className="panel-card__header">Skills Coverage</div>
                  <div className="skills-summary">
                    <div className="skills-block">
                      <div className="skills-label">Required</div>
                      <div className="chip-grid">
                        {analysis.requiredSkills.length ? (
                          analysis.requiredSkills.map((skill) => (
                            <span key={`req-${skill}`} className="chip">
                              {skill}
                            </span>
                          ))
                        ) : (
                          <span className="chip chip--success">No required keywords</span>
                        )}
                      </div>
                    </div>
                    <div className="skills-block">
                      <div className="skills-label">Matching</div>
                      <div className="chip-grid">
                        {analysis.matchedSkills.length ? (
                          analysis.matchedSkills.map((skill) => (
                            <span key={`match-${skill}`} className="chip">
                              {skill}
                            </span>
                          ))
                        ) : (
                          <span className="chip">None detected</span>
                        )}
                      </div>
                    </div>
                    <div className="skills-block">
                      <div className="skills-label">Missing</div>
                      <div className="chip-grid">
                        {analysis.missingSkills.length ? (
                          analysis.missingSkills.map((skill) => (
                            <span key={`miss-${skill}`} className="chip">
                              {skill}
                            </span>
                          ))
                        ) : (
                          <span className="chip chip--success">All key skills matched</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="panel-card">
                  <div className="panel-card__header">Must-Fix Issues</div>
                  <ul className="checklist">
                    {analysis.issues.length ? (
                      analysis.issues.map((issue) => <li key={issue}>{issue}</li>)
                    ) : (
                      <li>No critical issues detected.</li>
                    )}
                  </ul>
                </div>
              </div>

              <div className="panel-card panel-card--wide">
                <div className="panel-card__header">Summary Changes</div>
                {summaryChange ? (
                  <div className="rewrite-item">
                    <div className="rewrite-columns">
                      <div>
                        <span>Original</span>
                        <p>{summaryChange.before || '—'}</p>
                      </div>
                      <div>
                        <span>Improved</span>
                        <p>{summaryChange.after}</p>
                      </div>
                    </div>
                    <button
                      className={`toggle-btn${changeState[summaryChange.id] ? ' toggle-btn--on' : ''}`}
                      type="button"
                      onClick={() => toggleChange(summaryChange.id)}
                    >
                      {changeState[summaryChange.id] ? 'Applied' : 'Apply'}
                    </button>
                  </div>
                ) : (
                  <div className="change-empty">No summary changes suggested.</div>
                )}
              </div>

              <div className="panel-card panel-card--wide">
                <div className="panel-card__header">Skills Changes</div>
                {skillChanges.length ? (
                  skillChanges.map((item) => (
                    <div key={item.id} className="change-group">
                      <div className="change-group__title">{item.title || 'Skill'}</div>
                      <div className="rewrite-item change-item">
                        <div className="rewrite-columns diff-columns">
                          {(() => {
                            const diff = diffWords(item.before || '', item.after || '')
                            return (
                              <>
                                <div>
                                  <span>Original</span>
                                  <p className="diff-line" dangerouslySetInnerHTML={{ __html: diff.beforeHtml }} />
                                </div>
                                <div>
                                  <span>Improved</span>
                                  <p className="diff-line" dangerouslySetInnerHTML={{ __html: diff.afterHtml }} />
                                </div>
                              </>
                            )
                          })()}
                        </div>
                        <button
                          className={`toggle-btn${changeState[item.id] ? ' toggle-btn--on' : ''}`}
                          type="button"
                          onClick={() => toggleChange(item.id)}
                        >
                          {changeState[item.id] ? 'Applied' : 'Apply'}
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="change-empty">No skills changes suggested.</div>
                )}
              </div>

              <div className="panel-card panel-card--wide">
                <div className="panel-card__header">Experience Changes</div>
                {Object.keys(experienceGroups).length ? (
                  Object.entries(experienceGroups).map(([group, items]) => (
                    <div key={group} className="change-group">
                      <div className="change-group__title">{group}</div>
                      {items.map((item) => {
                        const diff = diffWords(item.before || '', item.after || '')
                        return (
                          <div key={item.id} className="rewrite-item change-item">
                            <div className="rewrite-columns diff-columns">
                              <div>
                                <span>Original</span>
                                <p className="diff-line" dangerouslySetInnerHTML={{ __html: diff.beforeHtml }} />
                              </div>
                              <div>
                                <span>Improved</span>
                                <p className="diff-line" dangerouslySetInnerHTML={{ __html: diff.afterHtml }} />
                              </div>
                            </div>
                            <button
                              className={`toggle-btn${changeState[item.id] ? ' toggle-btn--on' : ''}`}
                              type="button"
                              onClick={() => toggleChange(item.id)}
                            >
                              {changeState[item.id] ? 'Applied' : 'Apply'}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ))
                ) : (
                  <div className="change-empty">No experience point changes suggested.</div>
                )}
              </div>

              <div className="panel-card panel-card--wide">
                <div className="panel-card__header">Project Changes</div>
                {Object.keys(projectGroups).length ? (
                  Object.entries(projectGroups).map(([group, items]) => (
                    <div key={group} className="change-group">
                      <div className="change-group__title">{group}</div>
                      {items.map((item) => {
                        const diff = diffWords(item.before || '', item.after || '')
                        return (
                          <div key={item.id} className="rewrite-item change-item">
                            <div className="rewrite-columns diff-columns">
                              <div>
                                <span>Original</span>
                                <p className="diff-line" dangerouslySetInnerHTML={{ __html: diff.beforeHtml }} />
                              </div>
                              <div>
                                <span>Improved</span>
                                <p className="diff-line" dangerouslySetInnerHTML={{ __html: diff.afterHtml }} />
                              </div>
                            </div>
                            <button
                              className={`toggle-btn${changeState[item.id] ? ' toggle-btn--on' : ''}`}
                              type="button"
                              onClick={() => toggleChange(item.id)}
                            >
                              {changeState[item.id] ? 'Applied' : 'Apply'}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ))
                ) : (
                  <div className="change-empty">No project point changes suggested.</div>
                )}
              </div>

              <div className="panel-footer">
                <div className="panel-footer__group">
                  <button className="btn btn-ghost" type="button" onClick={() => setCurrentStep(2)}>
                    Back
                  </button>
                  <button className="btn btn-ghost" type="button" onClick={() => setAllChanges(false)}>
                    Undo all
                  </button>
                  <button className="btn btn-ghost" type="button" onClick={() => setAllChanges(true)}>
                    Apply all
                  </button>
                </div>
                <div className="panel-footer__group">
                  <div className="change-status">Applied changes: {appliedCount} · Match now {improvedScore}%</div>
                  <button className="btn btn-primary" type="button" onClick={handleContinueToExport}>
                    Continue to Export
                  </button>
                </div>
              </div>
            </article>
          )}

          {currentStep === 4 && analysis && (
            <article className="panel">
              <header className="panel-header">
                <span className="step-badge">4</span>
                <div>
                  <h2>Export Updated Resume</h2>
                  <p>Download the polished resume in DOCX format.</p>
                </div>
              </header>

              <div className="export-stack">
                <div className="panel-card">
                  <div className="panel-card__header">Download Resume</div>
                  <p className="summary">
                    Tailored for {analysis.roleTitle}. Match score improved to {improvedScore}% after applying {appliedCount}{' '}
                    changes.
                  </p>
                  <div className="change-status">Applied changes: {appliedCount} · Match now {improvedScore}%</div>
                  <div className="action-row">
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={handleDownload}
                      disabled={exportingDocx}
                    >
                      {exportingDocx ? 'Generating DOCX…' : 'Download DOCX'}
                    </button>
                  </div>
                  {exportError && <div className="alert">{exportError}</div>}
                  <div className="helper-text">DOCX is generated on the server.</div>

                  <div className="resume-doc">
                    <div className="resume-doc__header">
                      <div>
                        <h3>{analysis.roleTitle}</h3>
                        <p>Updated resume document</p>
                      </div>
                      <span className="resume-tag">Updated</span>
                    </div>
                    <pre className="resume-doc__text">{resumeDocText || resumePreview}</pre>
                  </div>
                </div>
              </div>

              <div className="panel-footer">
                <div className="panel-footer__group">
                  <button className="btn btn-ghost" type="button" onClick={() => setCurrentStep(3)}>
                    Back to Results
                  </button>
                </div>
              </div>
            </article>
          )}
        </section>
      </main>
      <footer className="footer">
        <div>Developed by Sai Bharath Padigala</div>
        <div>Contact: saibharath3693@gmail.com</div>
      </footer>
    </div>
  )
}

export default App
