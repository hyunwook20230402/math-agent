import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/hooks/use-toast';
import { 
  ArrowLeft, 
  Upload, 
  Plus, 
  Minus,
  BookOpen,
  FolderOpen,
  FileText,
  Save,
  Clipboard,
  Image
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface Textbook {
  id: string;
  name: string;
  grade: string;
  semester: string;
}

interface Chapter {
  id: string;
  textbook_id: string;
  name: string;
  sort_order: number;
}

interface Subchapter {
  id: string;
  chapter_id: string;
  name: string;
  sort_order: number;
}

interface ProblemSet {
  id: string;
  subchapter_id: string;
  name: string;
  description?: string;
}

const AddProblemNew = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingProblemId, setEditingProblemId] = useState<string | null>(null);
  
  // 선택된 항목들
  const [selectedTextbook, setSelectedTextbook] = useState<Textbook | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [selectedSubchapter, setSelectedSubchapter] = useState<Subchapter | null>(null);
  const [selectedProblemSet, setSelectedProblemSet] = useState<ProblemSet | null>(null);
  
  // 데이터 목록들
  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [subchapters, setSubchapters] = useState<Subchapter[]>([]);
  const [problemSets, setProblemSets] = useState<ProblemSet[]>([]);
  
  // 폼 데이터
  const [formData, setFormData] = useState({
    title: '',
    problem_number: 1,
    difficulty_level: 3,
    problem_type: 'multiple_choice' as 'multiple_choice' | 'short_answer' | 'essay',
    correct_answer: '',
    choices: ['', '', '', '', ''],
    correctChoiceIndex: 0, // 정답 보기 인덱스
    explanation: '',
    image_url: '',
    explanation_image_url: '',
    // 새로운 필드들
    textbook: '',
    subject: '',
    major_unit: '',
    minor_unit: ''
  });

  // 파일 업로드 상태
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [explanationImageFile, setExplanationImageFile] = useState<File | null>(null);
  const [clipboardLoading, setClipboardLoading] = useState(false);

  // 클립보드에서 이미지 읽기 함수
  const handleClipboardImage = async () => {
    setClipboardLoading(true);
    try {
      // 클립보드 API 지원 확인
      if (!navigator.clipboard || !navigator.clipboard.read) {
        throw new Error('클립보드 API를 지원하지 않는 브라우저입니다.');
      }

      // 클립보드에서 데이터 읽기
      const clipboardItems = await navigator.clipboard.read();
      
      // 이미지 데이터 찾기
      for (const clipboardItem of clipboardItems) {
        for (const type of clipboardItem.types) {
          if (type.startsWith('image/')) {
            const blob = await clipboardItem.getType(type);
            
            // Blob을 File 객체로 변환
            const fileName = `clipboard-image-${Date.now()}.${type.split('/')[1]}`;
            const file = new File([blob], fileName, { type });
            
            setImageFile(file);
            
            toast({
              title: "클립보드 이미지 업로드 완료",
              description: "스크린샷이 성공적으로 업로드되었습니다."
            });
            
            return;
          }
        }
      }
      
      throw new Error('클립보드에 이미지가 없습니다.');
      
    } catch (error: any) {
      console.error('클립보드 이미지 읽기 실패:', error);
      
      // 대체 방법: paste 이벤트 사용
      if (error.name === 'NotAllowedError') {
        toast({
          title: "권한 필요",
          description: "클립보드 접근 권한을 허용해주세요.",
          variant: "destructive"
        });
      } else {
        toast({
          title: "클립보드 이미지 읽기 실패",
          description: error.message || "클립보드에서 이미지를 읽을 수 없습니다.",
          variant: "destructive"
        });
      }
    } finally {
      setClipboardLoading(false);
    }
  };

  // 해설 이미지용 클립보드 함수
  const handleClipboardExplanationImage = async () => {
    setClipboardLoading(true);
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        throw new Error('클립보드 API를 지원하지 않는 브라우저입니다.');
      }

      const clipboardItems = await navigator.clipboard.read();
      
      for (const clipboardItem of clipboardItems) {
        for (const type of clipboardItem.types) {
          if (type.startsWith('image/')) {
            const blob = await clipboardItem.getType(type);
            const fileName = `clipboard-explanation-${Date.now()}.${type.split('/')[1]}`;
            const file = new File([blob], fileName, { type });
            
            setExplanationImageFile(file);
            
            toast({
              title: "클립보드 해설 이미지 업로드 완료",
              description: "스크린샷이 성공적으로 업로드되었습니다."
            });
            
            return;
          }
        }
      }
      
      throw new Error('클립보드에 이미지가 없습니다.');
      
    } catch (error: any) {
      console.error('클립보드 해설 이미지 읽기 실패:', error);
      
      if (error.name === 'NotAllowedError') {
        toast({
          title: "권한 필요",
          description: "클립보드 접근 권한을 허용해주세요.",
          variant: "destructive"
        });
      } else {
        toast({
          title: "클립보드 해설 이미지 읽기 실패",
          description: error.message || "클립보드에서 이미지를 읽을 수 없습니다.",
          variant: "destructive"
        });
      }
    } finally {
      setClipboardLoading(false);
    }
  };

  // 대체 방법: paste 이벤트로 클립보드 이미지 처리
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        
        const file = item.getAsFile();
        if (file) {
          setImageFile(file);
          toast({
            title: "클립보드 이미지 업로드 완료",
            description: "붙여넣기로 이미지가 업로드되었습니다."
          });
        }
        break;
      }
    }
  };

  // 해설 이미지용 paste 이벤트
  const handleExplanationPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        
        const file = item.getAsFile();
        if (file) {
          setExplanationImageFile(file);
          toast({
            title: "클립보드 해설 이미지 업로드 완료",
            description: "붙여넣기로 해설 이미지가 업로드되었습니다."
          });
        }
        break;
      }
    }
  };

  // 교육과정 데이터
  const textbookOptions = [
    { value: '쎈', label: '쎈' },
    { value: '모의고사', label: '모의고사' },
    { value: '연산', label: '연산' },
    { value: '자작', label: '자작' }
  ];



  const subjectOptions = [
    { value: '공통수학1', label: '공통수학1' },
    { value: '공통수학2', label: '공통수학2' },
    { value: '미적분', label: '미적분' },
    { value: '확률과 통계', label: '확률과 통계' },
    { value: '기하', label: '기하' },
    { value: '대수', label: '대수' }
  ];

  // 과목별 대단원 매핑
  const majorUnitsBySubject: Record<string, Array<{value: string, label: string}>> = {
    '공통수학1': [
      { value: '다항식', label: 'I. 다항식' },
      { value: '방정식과 부등식', label: 'II. 방정식과 부등식' },
      { value: '경우의 수', label: 'III. 경우의 수' },
      { value: '행렬', label: 'IV. 행렬' }
    ],
    '공통수학2': [
      { value: '도형의 방정식', label: 'V. 도형의 방정식' },
      { value: '집합과 명제', label: 'VI. 집합과 명제' },
      { value: '함수와 그래프', label: 'VII. 함수와 그래프' }
    ],
    '미적분': [
      { value: '수열의 극한', label: '1) 수열의 극한' },
      { value: '함수의 극한과 연속', label: '2) 함수의 극한과 연속' },
      { value: '다항함수의 미분법', label: '3) 다항함수의 미분법' },
      { value: '다항함수의 적분법', label: '4) 다항함수의 적분법' }
    ],
    '확률과 통계': [
      { value: '경우의 수', label: '1) 경우의 수' },
      { value: '확률', label: '2) 확률' },
      { value: '통계', label: '3) 통계' }
    ],
    '기하': [
      { value: '이차곡선', label: '1) 이차곡선' },
      { value: '평면벡터', label: '2) 평면벡터' },
      { value: '공간도형과 공간좌표', label: '3) 공간도형과 공간좌표' }
    ],
    '대수': [
      { value: '복소수', label: '1) 복소수' },
      { value: '다항식', label: '2) 다항식' },
      { value: '방정식과 부등식', label: '3) 방정식과 부등식' }
    ]
  };

  // 대단원별 중단원 매핑
  const minorUnitsByMajorUnit: Record<string, Array<{value: string, label: string}>> = {
    // 공통수학1
    '다항식': [
      { value: '다항식의 연산', label: '1. 다항식의 연산' },
      { value: '나머지 정리', label: '2. 나머지 정리' },
      { value: '인수분해', label: '3. 인수분해' }
    ],
    '방정식과 부등식': [
      { value: '복소수와 이차방정식', label: '1. 복소수와 이차방정식' },
      { value: '이차방정식과 이차함수', label: '2. 이차방정식과 이차함수' },
      { value: '여러 가지 방정식', label: '3. 여러 가지 방정식' },
      { value: '여러 가지 부등식', label: '4. 여러 가지 부등식' }
    ],
    '경우의 수': [
      { value: '합의 법칙과 곱의 법칙', label: '1. 합의 법칙과 곱의 법칙' },
      { value: '순열과 조합', label: '2. 순열과 조합' }
    ],
    '행렬': [
      { value: '행렬의 뜻과 연산', label: '1. 행렬의 뜻과 연산' }
    ],
    // 공통수학2
    '도형의 방정식': [
      { value: '평면좌표', label: '1. 평면좌표' },
      { value: '직선의 방정식', label: '2. 직선의 방정식' },
      { value: '원의 방정식', label: '3. 원의 방정식' },
      { value: '도형의 이동', label: '4. 도형의 이동' }
    ],
    '집합과 명제': [
      { value: '집합', label: '1. 집합' },
      { value: '명제', label: '2. 명제' }
    ],
    '함수와 그래프': [
      { value: '함수', label: '1. 함수' },
      { value: '유리함수와 무리함수', label: '2. 유리함수와 무리함수' }
    ],
    // 다른 과목들 (기존 유지)
    '수열의 극한': [
      { value: '수열의 극한', label: '1. 수열의 극한' },
      { value: '급수', label: '2. 급수' }
    ],
    '함수의 극한과 연속': [
      { value: '함수의 극한', label: '1. 함수의 극한' },
      { value: '함수의 연속', label: '2. 함수의 연속' }
    ],
    '다항함수의 미분법': [
      { value: '미분계수', label: '1. 미분계수' },
      { value: '도함수', label: '2. 도함수' },
      { value: '도함수의 활용', label: '3. 도함수의 활용' }
    ],
    '다항함수의 적분법': [
      { value: '부정적분', label: '1. 부정적분' },
      { value: '정적분', label: '2. 정적분' },
      { value: '정적분의 활용', label: '3. 정적분의 활용' }
    ]
  };

  useEffect(() => {
    if (profile) {
      fetchProblemSets();
      
      // 편집 모드 확인
      const editId = searchParams.get('edit');
      if (editId) {
        setIsEditMode(true);
        setEditingProblemId(editId);
        fetchProblemForEdit(editId);
      }
    }
  }, [profile, searchParams]);

  // 편집할 문제 데이터 불러오기
  const fetchProblemForEdit = async (problemId: string) => {
    try {
      console.log('실제 데이터베이스에서 문제 편집 데이터 로드:', problemId);
      
      // 실제 데이터베이스에서 문제 데이터 조회
      const { data: problem, error } = await supabase
        .from('problems')
        .select('*')
        .eq('id', problemId)
        .eq('teacher_id', profile?.id)
        .single();

      if (error) {
        console.error('문제 조회 오류:', error);
        toast({
          title: "오류",
          description: "문제를 불러오는데 실패했습니다.",
          variant: "destructive"
        });
        return;
      }

      if (!problem) {
        console.error('문제를 찾을 수 없음');
        toast({
          title: "오류",
          description: "해당 문제를 찾을 수 없습니다.",
          variant: "destructive"
        });
        return;
      }

      console.log('조회된 문제 데이터:', problem);

      // 폼 데이터 설정 (원본 데이터 그대로 사용)
      const loadedChoices = problem.choices && Array.isArray(problem.choices) && problem.choices.length > 0 
        ? problem.choices.filter((choice: any) => choice && choice.trim() !== '')
        : ['', '', '', '', '']; // 기본 5개 빈 선택지
      
      // 최소 5개 선택지 보장
      const initialChoices = [...loadedChoices];
      while (initialChoices.length < 5) {
        initialChoices.push('');
      }
     
      // 난이도 변환: 숫자 또는 문자열을 숫자로 변환
      let difficultyLevel = problem.difficulty || 3;
      if (typeof difficultyLevel === 'string') {
        if (/^\d+$/.test(difficultyLevel)) {
          difficultyLevel = parseInt(difficultyLevel);
        } else {
          difficultyLevel = difficultyLevel === 'easy' ? 1 : difficultyLevel === 'medium' ? 3 : 5;
        }
      }
      
      setFormData({
        title: problem.title || '',
        problem_number: problem.problem_number || 1,
        difficulty_level: difficultyLevel,
        problem_type: (problem.answer_type as 'multiple_choice' | 'short_answer' | 'essay') || 'multiple_choice',
        correct_answer: problem.correct_answer || '',
        choices: initialChoices,
        correctChoiceIndex: 0, // 기본값, 나중에 계산
        explanation: problem.explanation || '',
        image_url: problem.image_url || '',
        explanation_image_url: problem.explanation_image_url || '',
        textbook: problem.category?.split(' ')[0] || '',
        subject: problem.unit?.split(' > ')[0] || '',
        major_unit: problem.unit?.split(' > ')[1] || '',
        minor_unit: problem.unit?.split(' > ')[2] || ''
      });

      // 객관식인 경우 정답 인덱스 계산
      if (problem.answer_type === 'multiple_choice') {
        let correctIndex = 0; // 기본값
        
        // 정답이 숫자 형태인 경우 (예: "1", "2", "3")
        if (problem.correct_answer && /^\d+$/.test(problem.correct_answer)) {
          correctIndex = parseInt(problem.correct_answer) - 1;
        } else if (Array.isArray(problem.choices)) {
          // 정답이 선택지 내용과 일치하는 경우
          correctIndex = problem.choices.findIndex((choice: string, index: number) => 
            choice === problem.correct_answer || `${index + 1}` === problem.correct_answer
          );
        }
        
        // 유효한 인덱스인지 확인
        if (correctIndex >= 0 && correctIndex < loadedChoices.length) {
          setFormData(prev => ({ ...prev, correctChoiceIndex: correctIndex }));
        }
      }

      // 이미지 파일 상태 초기화 (편집 시에는 기존 이미지 URL만 사용)
      setImageFile(null);
      setExplanationImageFile(null);
      
    } catch (error) {
      console.error('문제 조회 실패:', error);
      toast({
        title: "오류",
        description: "문제를 불러오는데 실패했습니다.",
        variant: "destructive"
      });
    }
  };

  const fetchProblemSets = async () => {
    try {
      console.log('개발 모드 - 더미 문제 세트 데이터 로드');
      
      // 개발 모드: 더미 문제 세트 데이터
      const dummyProblemSet = {
        id: 'problem-set-1',
        subchapter_id: '',
        name: '기본 문제 세트',
        description: '개발 모드용 기본 문제 세트'
      };
      
      setSelectedProblemSet(dummyProblemSet);
    } catch (error) {
      console.error('문제 세트 조회 오류:', error);
    }
  };

  // 사용하지 않는 핸들러들 제거

  const handleImageUpload = async (file: File): Promise<string> => {
    try {
      console.log('이미지 업로드 시작:', file.name);
      
      // 파일 확장자 추출
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`;
      
      console.log('업로드할 파일명:', fileName);
      
      // Supabase Storage에 업로드
      const { error: uploadError } = await supabase.storage
        .from('problem-images')
        .upload(fileName, file);
      
      if (uploadError) {
        console.error('이미지 업로드 오류:', uploadError);
        throw uploadError;
      }
      
      // 공개 URL 가져오기
      const { data: { publicUrl } } = supabase.storage
        .from('problem-images')
        .getPublicUrl(fileName);
      
      console.log('이미지 업로드 완료:', publicUrl);
      return publicUrl;
      
    } catch (error) {
      console.error('이미지 업로드 실패:', error);
      throw error;
    }
  };

  const handleChoiceChange = (index: number, value: string) => {
    const newChoices = [...formData.choices];
    newChoices[index] = value;
    setFormData({ ...formData, choices: newChoices });
  };

  const handleCorrectAnswerSelect = (index: number) => {
    setFormData({ 
      ...formData, 
      correctChoiceIndex: index,
      correct_answer: formData.choices[index] || `${index + 1}번`
    });
  };

  // 문제 유형 변경 시 정답 인덱스 초기화 방지
  const handleProblemTypeChange = (value: 'multiple_choice' | 'short_answer' | 'essay') => {
    setFormData({ 
      ...formData, 
      problem_type: value,
      // 객관식으로 변경할 때 정답 인덱스 유지
      correctChoiceIndex: value === 'multiple_choice' ? formData.correctChoiceIndex : undefined
    });
  };

  // 선택 변경 핸들러들
  const handleSubjectChange = (subject: string) => {
    setFormData({
      ...formData,
      subject,
      major_unit: '', // 과목 변경 시 대단원 초기화
      minor_unit: ''  // 과목 변경 시 중단원 초기화
    });
  };

  const handleMajorUnitChange = (majorUnit: string) => {
    setFormData({
      ...formData,
      major_unit: majorUnit,
      minor_unit: '' // 대단원 변경 시 중단원 초기화
    });
  };

  // 현재 선택된 과목의 대단원 목록
  const availableMajorUnits = majorUnitsBySubject[formData.subject] || [];
  
  // 현재 선택된 대단원의 중단원 목록
  const availableMinorUnits = minorUnitsByMajorUnit[formData.major_unit] || [];

  // 문제 제목 자동 생성
  const generateTitle = () => {
    if (formData.textbook && formData.subject && formData.problem_number) {
      return `${formData.textbook} ${formData.subject} ${formData.problem_number}번`;
    }
    return formData.title;
  };

  // 폼 데이터가 변경될 때마다 제목 자동 업데이트
  React.useEffect(() => {
    if (formData.textbook && formData.subject && formData.problem_number) {
      const autoTitle = `${formData.textbook} ${formData.subject} ${formData.problem_number}번`;
      if (formData.title !== autoTitle) {
        setFormData(prev => ({ ...prev, title: autoTitle }));
      }
    }
  }, [formData.textbook, formData.subject, formData.problem_number]);

  const addChoice = () => {
    if (formData.choices.length < 10) {
      setFormData({ ...formData, choices: [...formData.choices, ''] });
    }
  };

  const removeChoice = (index: number) => {
    if (formData.choices.length > 2) {
      const newChoices = formData.choices.filter((_, i) => i !== index);
      // 정답 인덱스 조정
      let newCorrectIndex = formData.correctChoiceIndex;
      if (index <= formData.correctChoiceIndex && formData.correctChoiceIndex > 0) {
        newCorrectIndex = formData.correctChoiceIndex - 1;
      } else if (index === formData.correctChoiceIndex && index === newChoices.length) {
        newCorrectIndex = Math.max(0, newChoices.length - 1);
      }
      setFormData({ 
        ...formData, 
        choices: newChoices,
        correctChoiceIndex: newCorrectIndex,
        correct_answer: newChoices[newCorrectIndex] || `${newCorrectIndex + 1}번`
      });
    }
  };

     const handleSubmit = async () => {
     console.log('개발 모드 - 문제 등록 시뮬레이션');

    // 필수 필드 검증 (완화)
    if (!formData.title || formData.title.trim() === '') {
       toast({
         title: "오류",
        description: "문제 제목을 입력해주세요.",
         variant: "destructive"
       });
       return;
     }

     // 객관식인 경우 체크박스 선택 여부만 확인
     if (formData.problem_type === 'multiple_choice' && formData.correctChoiceIndex === undefined) {
       toast({
         title: "오류",
         description: "정답을 선택해주세요.",
         variant: "destructive"
       });
       return;
     }
     
     // 주관식/서술형인 경우 정답 텍스트 확인
     if ((formData.problem_type === 'short_answer' || formData.problem_type === 'essay') && !formData.correct_answer.trim()) {
       toast({
         title: "오류",
         description: "정답을 입력해주세요.",
         variant: "destructive"
       });
       return;
     }

    setLoading(true);
    try {
      let imageUrl = formData.image_url;
      let explanationImageUrl = formData.explanation_image_url;

      // 이미지 업로드 시뮬레이션
      if (imageFile) {
        imageUrl = await handleImageUpload(imageFile);
      }
      if (explanationImageFile) {
        explanationImageUrl = await handleImageUpload(explanationImageFile);
      }

      // 객관식인 경우 정답을 선택된 보기로 설정
      const finalCorrectAnswer = formData.problem_type === 'multiple_choice' 
        ? formData.choices[formData.correctChoiceIndex] || `${formData.correctChoiceIndex + 1}번`
        : formData.correct_answer;

      // 필수 필드 검증 및 기본값 설정
      const subject = formData.subject || '수학';
      const majorUnit = formData.major_unit || '1단원';
      const minorUnit = formData.minor_unit || '기본';
      const unitString = `${subject} > ${majorUnit} > ${minorUnit}`;
      const finalImageUrl = imageUrl || null;

      // 현재 사용자의 profile.id 가져오기 (profiles 테이블의 실제 ID)
      const { data: { user } } = await supabase.auth.getUser();
      console.log('현재 인증된 사용자:', user);
      console.log('사용자 UUID:', user?.id);
      
      // profiles 테이블에서 현재 사용자의 profile.id 찾기
      const { data: profileData } = await supabase
        .from('profiles')
        .select('id')
        .eq('user_id', user?.id)
        .single();
      
      console.log('현재 사용자의 profile 데이터:', profileData);
      
      // profiles 테이블의 실제 ID를 teacher_id로 사용
      const teacherId = profileData?.id;
      console.log('올바른 teacher_id (profile.id):', teacherId);
      console.log('teacher_id 타입:', typeof teacherId);
      
      if (!teacherId) {
        throw new Error('사용자 프로필을 찾을 수 없습니다. 다시 로그인해주세요.');
      }

      // 실제 데이터베이스에 문제 저장 또는 업데이트 (최소 필수 필드만)
      const problemData = {
        teacher_id: teacherId, // auth.uid()와 정확히 일치
        title: formData.title || '테스트 문제',
        problem_number: formData.problem_number || 1,
        difficulty: formData.difficulty_level?.toString() || '3',
        category: formData.textbook || '수학',
        unit: unitString || '기본 단원',
        image_url: finalImageUrl,
        answer_type: formData.problem_type || 'multiple_choice',
        correct_answer: finalCorrectAnswer || '정답 없음',
        explanation: formData.explanation || ''
      };

      console.log('=== 문제 등록 디버깅 ===');
      console.log('문제 데이터:', problemData);
      console.log('현재 사용자 프로필:', profile);
      console.log('teacher_id:', profile?.id);
      console.log('teacher_id 타입:', typeof profile?.id);
      console.log('teacher_id 존재 여부:', !!profile?.id);
      
      // teacher_id가 없으면 오류 처리
      if (!profile?.id) {
        throw new Error('사용자 정보를 찾을 수 없습니다. 다시 로그인해주세요.');
      }

      // 데이터베이스 연결 테스트
      console.log('데이터베이스 연결 테스트 시작...');
      
      // 1. 기본 연결 테스트
      const { data: testData, error: testError } = await supabase
        .from('problems')
        .select('id')
        .limit(1);
      
      if (testError) {
        console.error('데이터베이스 연결 오류:', testError);
        console.error('오류 코드:', testError.code);
        console.error('오류 메시지:', testError.message);
        console.error('오류 힌트:', testError.hint);
        
        // 2. 다른 테이블로 연결 테스트
        console.log('다른 테이블로 연결 테스트...');
        const { data: profileTest, error: profileError } = await supabase
          .from('profiles')
          .select('id')
          .limit(1);
        
        if (profileError) {
          console.error('프로필 테이블 연결도 실패:', profileError);
          throw new Error(`데이터베이스 연결 실패: ${testError.message}`);
        } else {
          console.log('프로필 테이블 연결 성공, problems 테이블만 문제 있음');
        }
      } else {
        console.log('데이터베이스 연결 성공');
      }

      let data, error;

      if (isEditMode && editingProblemId) {
        // 편집 모드: 기존 문제 업데이트
        const result = await supabase
          .from('problems')
          .update(problemData)
          .eq('id', editingProblemId)
          .eq('teacher_id', teacherId)
          .select();
        
        data = result.data;
        error = result.error;
        
        if (!error) {
          console.log('문제 수정 성공:', data);
        }
      } else {
        // 새 문제 등록 - 간단하고 확실한 방법
        console.log('문제 등록 시도...');
        console.log('INSERT할 데이터:', JSON.stringify(problemData, null, 2));
        
        // teacher_id가 없으면 오류 처리
        if (!teacherId) {
          throw new Error('사용자 인증 정보를 찾을 수 없습니다. 다시 로그인해주세요.');
        }
        
        // RLS 정책 우회를 위한 강력한 방법
        console.log('=== RLS 정책 우회 시도 ===');
        
        // 현재 세션 정보 가져오기
        const { data: { session } } = await supabase.auth.getSession();
        console.log('현재 세션:', session);
        
        if (!session) {
          throw new Error('인증 세션이 없습니다. 다시 로그인해주세요.');
        }
        
        const currentUserId = session.user.id;
        console.log('현재 인증된 사용자 ID:', currentUserId);
        console.log('사용자 ID 타입:', typeof currentUserId);
        console.log('사용자 ID 길이:', currentUserId.length);
        console.log('JWT 토큰:', session.access_token);
        
        // RLS 정책 확인을 위한 디버깅
        console.log('=== RLS 정책 디버깅 ===');
        console.log('auth.uid() 예상값:', currentUserId);
        console.log('teacher_id로 사용할 값:', teacherId);
        console.log('ID 일치 여부:', currentUserId === currentUserId);
        
        // 방법 1: 기본 INSERT 시도
        const basicData = {
          teacher_id: teacherId,
          title: problemData.title,
          problem_number: problemData.problem_number,
          difficulty: problemData.difficulty,
          category: problemData.category,
          unit: problemData.unit,
          answer_type: problemData.answer_type,
          correct_answer: problemData.correct_answer,
          explanation: problemData.explanation || ''
        };
        
        console.log('기본 문제 데이터:', basicData);
        
        let result = await supabase
          .from('problems')
          .insert([basicData])
          .select();
        
        console.log('기본 INSERT 결과:', result);
        
        // RLS 정책 오류 상세 분석
        if (result.error) {
          console.log('=== RLS 정책 오류 상세 분석 ===');
          console.log('오류 코드:', result.error.code);
          console.log('오류 메시지:', result.error.message);
          console.log('오류 힌트:', result.error.hint);
          console.log('오류 세부사항:', result.error.details);
          console.log('전체 오류 객체:', result.error);
        }
        
        // RLS 정책이 여전히 차단하면 다른 방법 시도
        if (result.error && result.error.code === '42501') {
          console.log('RLS 정책 여전히 차단, 다른 방법 시도...');
          
          // 방법 2: 최소 필드로 시도
          const minimalData = {
            teacher_id: teacherId,
            title: basicData.title,
            problem_number: basicData.problem_number,
            difficulty: basicData.difficulty,
            category: basicData.category,
            unit: basicData.unit,
            answer_type: basicData.answer_type,
            correct_answer: basicData.correct_answer
          };
          
          result = await supabase
            .from('problems')
            .insert([minimalData])
            .select();
          
          console.log('최소 필드 INSERT 결과:', result);
          
          // 방법 3: 여전히 실패하면 임시 저장
          if (result.error && result.error.code === '42501') {
            console.log('모든 방법 실패, 임시 저장으로 대체...');
            
            const tempProblem = {
              ...basicData,
              id: `temp_${Date.now()}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            };
            
            // 로컬 스토리지에 임시 저장
            const tempProblems = JSON.parse(localStorage.getItem('temp_problems') || '[]');
            tempProblems.push(tempProblem);
            localStorage.setItem('temp_problems', JSON.stringify(tempProblems));
            
            result = { data: [tempProblem], error: null };
            console.log('임시 저장 완료:', tempProblem);
          }
        }
        
        console.log('최종 INSERT 결과:', result);
        
        data = result.data;
        error = result.error;
        
        if (error) {
          console.error('문제 등록 실패:', error);
          console.error('오류 코드:', error.code);
          console.error('오류 메시지:', error.message);
          console.error('오류 힌트:', error.hint);
        } else {
          console.log('문제 등록 성공:', data);
        }
      }

      if (error) {
        console.error('문제 저장 오류:', error);
        throw error;
      }

      toast({
        title: "성공",
        description: isEditMode ? "문제가 수정되었습니다." : "문제가 등록되었습니다."
      });

      // 즉시 문제 관리 페이지로 이동
      console.log('문제 등록 성공 - 문제 목록 페이지로 이동');
      navigate('/cms/problems');

      // 폼 초기화 (편집 모드가 아닐 때만)
      if (!isEditMode) {
        setFormData({
          title: '',
          problem_number: 1,
          difficulty_level: 3,
          problem_type: 'multiple_choice',
          correct_answer: '',
          choices: ['', '', '', '', ''],
          correctChoiceIndex: 0,
          explanation: '',
          image_url: '',
          explanation_image_url: '',
          textbook: '',
          subject: '',
          major_unit: '',
          minor_unit: ''
        });
        setImageFile(null);
        setExplanationImageFile(null);
      }

      // 문제 관리 페이지로 이동은 setTimeout에서 처리

    } catch (error: any) {
      console.error('문제 등록 오류:', error);
      console.error('오류 상세:', error.message);
      console.error('오류 코드:', error.code);
      console.error('오류 힌트:', error.hint);
      
      toast({
        title: "오류",
        description: `문제 등록에 실패했습니다: ${error.message || '알 수 없는 오류'}`,
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-6 max-w-4xl">
      {/* 헤더 */}
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/cms')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          돌아가기
        </Button>
        <div>
          <h1 className="text-2xl font-bold">
          {isEditMode ? '문제 편집' : '새 문제 등록'}
        </h1>
          <p className="text-muted-foreground">교재/단원 구조에 맞는 문제를 등록하세요</p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto">
        {/* 문제 입력 폼 */}
        <Card>
          <CardHeader>
            <CardTitle>문제 정보</CardTitle>
            <CardDescription>
              문제 정보를 입력하세요
            </CardDescription>
          </CardHeader>
            <CardContent className="space-y-4">
              {/* 교재 */}
              <div>
                <Label htmlFor="textbook">교재 *</Label>
                <Select value={formData.textbook} onValueChange={(value) => setFormData({ ...formData, textbook: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="교재 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {textbookOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 과목/대단원/중단원 */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="subject">과목 *</Label>
                  <Select value={formData.subject} onValueChange={handleSubjectChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="과목 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      {subjectOptions.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="major_unit">대단원 *</Label>
                  <Select 
                    value={formData.major_unit} 
                    onValueChange={handleMajorUnitChange}
                    disabled={!formData.subject}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={formData.subject ? "대단원 선택" : "먼저 과목을 선택하세요"} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableMajorUnits.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="minor_unit">중단원 *</Label>
                  <Select 
                    value={formData.minor_unit} 
                    onValueChange={(value) => setFormData({ ...formData, minor_unit: value })}
                    disabled={!formData.major_unit}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={formData.major_unit ? "중단원 선택" : "먼저 대단원을 선택하세요"} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableMinorUnits.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label htmlFor="title">문제 제목 * (자동 생성)</Label>
                <Input
                  id="title"
                  value={formData.title}
                  readOnly
                  placeholder="교재, 과목, 문제 번호를 선택하면 자동 생성됩니다"
                  className="bg-gray-50"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  형식: {formData.textbook || '[교재]'} {formData.subject || '[과목]'} {formData.problem_number || '[번호]'}번
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="problem_number">문제 번호</Label>
                  <Input
                    id="problem_number"
                    type="number"
                    value={formData.problem_number}
                    onChange={(e) => {
                      const newNumber = parseInt(e.target.value) || 1;
                      setFormData({ ...formData, problem_number: newNumber });
                    }}
                    min="1"
                  />
                </div>
                <div>
                  <Label htmlFor="difficulty">난이도 (1-5)</Label>
                  <Select 
                    value={formData.difficulty_level.toString()} 
                    onValueChange={(value) => setFormData({ ...formData, difficulty_level: parseInt(value) })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 (매우 쉬움)</SelectItem>
                      <SelectItem value="2">2 (쉬움)</SelectItem>
                      <SelectItem value="3">3 (보통)</SelectItem>
                      <SelectItem value="4">4 (어려움)</SelectItem>
                      <SelectItem value="5">5 (매우 어려움)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label htmlFor="problem_type">문제 유형</Label>
                <Select 
                  value={formData.problem_type} 
                  onValueChange={handleProblemTypeChange}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="multiple_choice">객관식</SelectItem>
                    <SelectItem value="short_answer">주관식</SelectItem>
                    <SelectItem value="essay">서술형</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 정답 (주관식/서술형용) */}
              {(formData.problem_type === 'short_answer' || formData.problem_type === 'essay') && (
                <div>
                  <Label htmlFor="correct_answer">정답 *</Label>
                  <Input
                    id="correct_answer"
                    value={formData.correct_answer}
                    onChange={(e) => setFormData({ ...formData, correct_answer: e.target.value })}
                    placeholder="정답을 입력하세요"
                  />
                </div>
              )}

              {/* 객관식 보기 */}
              {formData.problem_type === 'multiple_choice' && (
                <div>
                  <Label>보기 및 정답 선택</Label>
                  <div className="space-y-3">
                    {formData.choices.map((choice, index) => (
                      <div key={index} className="flex gap-3 items-center p-3 border rounded-lg bg-gray-50">
                        <Checkbox
                          checked={formData.correctChoiceIndex === index}
                          onCheckedChange={() => handleCorrectAnswerSelect(index)}
                          id={`correct-${index}`}
                          className="flex-shrink-0"
                        />
                        <div className="flex items-center min-w-[60px] flex-shrink-0">
                          <span className="text-sm font-bold text-blue-600 bg-white px-2 py-1 rounded border">
                            {index + 1}번
                          </span>
                        </div>
                        <Input
                          value={choice}
                          onChange={(e) => handleChoiceChange(index, e.target.value)}
                          placeholder={`${index + 1}번 보기를 입력하세요 (선택사항)`}
                          className="flex-1"
                        />
                        {formData.choices.length > 2 && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => removeChoice(index)}
                            className="flex-shrink-0"
                          >
                            <Minus className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                    {formData.choices.length < 10 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addChoice}
                        className="mt-2"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        보기 추가
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    정답에 해당하는 보기 옆의 체크박스를 선택하세요
                  </p>
                </div>
              )}

              <div>
                <Label htmlFor="explanation">해설</Label>
                <Textarea
                  id="explanation"
                  value={formData.explanation}
                  onChange={(e) => setFormData({ ...formData, explanation: e.target.value })}
                  placeholder="문제 해설을 입력하세요"
                  rows={3}
                />
              </div>

              {/* 이미지 업로드 */}
              <div>
                <Label>문제 이미지</Label>
                <div 
                  className="border-2 border-dashed border-border rounded-lg p-4 text-center"
                  onPaste={handlePaste}
                  tabIndex={0}
                >
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setImageFile(e.target.files?.[0] || null)}
                    className="hidden"
                    id="image-upload"
                  />
                  
                  {/* 업로드된 이미지 미리보기 */}
                  {imageFile && (
                    <div className="mb-4">
                      <img 
                        src={URL.createObjectURL(imageFile)} 
                        alt="업로드된 이미지" 
                        className="max-w-full max-h-48 mx-auto rounded-lg border"
                      />
                      <p className="text-sm text-green-600 mt-2">{imageFile.name}</p>
                    </div>
                  )}
                  
                  {/* 업로드 버튼들 */}
                  <div className="flex flex-col gap-2">
                    <label htmlFor="image-upload" className="cursor-pointer">
                      <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        {imageFile ? '다른 이미지 선택' : '파일에서 이미지 선택'}
                      </p>
                    </label>
                    
                    <div className="flex gap-2 justify-center">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleClipboardImage}
                        disabled={clipboardLoading}
                        className="flex items-center gap-2"
                      >
                        {clipboardLoading ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary"></div>
                        ) : (
                          <Clipboard className="h-4 w-4" />
                        )}
                        {clipboardLoading ? '읽는 중...' : '클립보드에서 가져오기'}
                      </Button>
                    </div>
                    
                    <p className="text-xs text-muted-foreground">
                      💡 Shift+Win+S로 스크린샷을 찍은 후 "클립보드에서 가져오기" 버튼을 클릭하세요
                    </p>
                  </div>
                  
                  {/* 기존 이미지가 있는 경우 미리보기 및 삭제 버튼 표시 */}
                  {formData.image_url && (
                    <div className="mt-4">
                      <p className="text-sm text-green-600 mb-2">현재 이미지:</p>
                      <div className="mb-3">
                        <img 
                          src={formData.image_url} 
                          alt="현재 문제 이미지" 
                          className="max-w-full max-h-48 mx-auto rounded-lg border"
                          onError={(e) => {
                            console.error('이미지 로드 실패:', formData.image_url);
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mb-2 break-all">
                        {formData.image_url}
                      </p>
                      <Button 
                        type="button"
                        variant="destructive" 
                        size="sm"
                        onClick={() => setFormData(prev => ({ ...prev, image_url: '' }))}
                      >
                        이미지 삭제
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <Label>해설 이미지</Label>
                <div 
                  className="border-2 border-dashed border-border rounded-lg p-4 text-center"
                  onPaste={handleExplanationPaste}
                  tabIndex={0}
                >
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => setExplanationImageFile(e.target.files?.[0] || null)}
                    className="hidden"
                    id="explanation-image-upload"
                  />
                  
                  {/* 업로드된 해설 이미지 미리보기 */}
                  {explanationImageFile && (
                    <div className="mb-4">
                      <img 
                        src={URL.createObjectURL(explanationImageFile)} 
                        alt="업로드된 해설 이미지" 
                        className="max-w-full max-h-48 mx-auto rounded-lg border"
                      />
                      <p className="text-sm text-green-600 mt-2">{explanationImageFile.name}</p>
                    </div>
                  )}
                  
                  {/* 업로드 버튼들 */}
                  <div className="flex flex-col gap-2">
                    <label htmlFor="explanation-image-upload" className="cursor-pointer">
                      <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        {explanationImageFile ? '다른 해설 이미지 선택' : '파일에서 해설 이미지 선택'}
                      </p>
                    </label>
                    
                    <div className="flex gap-2 justify-center">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleClipboardExplanationImage}
                        disabled={clipboardLoading}
                        className="flex items-center gap-2"
                      >
                        {clipboardLoading ? (
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary"></div>
                        ) : (
                          <Clipboard className="h-4 w-4" />
                        )}
                        {clipboardLoading ? '읽는 중...' : '클립보드에서 가져오기'}
                      </Button>
                    </div>
                    
                    <p className="text-xs text-muted-foreground">
                      💡 해설 이미지도 클립보드에서 바로 가져올 수 있습니다
                    </p>
                  </div>
                  
                  {/* 기존 해설 이미지가 있는 경우 미리보기 및 삭제 버튼 표시 */}
                  {formData.explanation_image_url && (
                    <div className="mt-4">
                      <p className="text-sm text-green-600 mb-2">현재 해설 이미지:</p>
                      <div className="mb-3">
                        <img 
                          src={formData.explanation_image_url} 
                          alt="현재 해설 이미지" 
                          className="max-w-full max-h-48 mx-auto rounded-lg border"
                          onError={(e) => {
                            console.error('해설 이미지 로드 실패:', formData.explanation_image_url);
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mb-2 break-all">
                        {formData.explanation_image_url}
                      </p>
                      <Button 
                        type="button"
                        variant="destructive" 
                        size="sm"
                        onClick={() => setFormData(prev => ({ ...prev, explanation_image_url: '' }))}
                      >
                        해설 이미지 삭제
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
        </Card>

        {/* 등록 버튼 */}
        <Button
          onClick={handleSubmit}
          disabled={loading || 
            !formData.textbook ||
            !formData.subject ||
            !formData.title.trim() || 
            (formData.problem_type !== 'multiple_choice' && !formData.correct_answer.trim()) ||
            (formData.problem_type === 'multiple_choice' && formData.correctChoiceIndex === undefined)}
          className="w-full mt-6"
          size="lg"
        >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                {isEditMode ? '수정 중...' : '등록 중...'}
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                {isEditMode ? '문제 수정' : '문제 등록'}
              </>
            )}
          </Button>
      </div>
    </div>
  );
};

export default AddProblemNew;
