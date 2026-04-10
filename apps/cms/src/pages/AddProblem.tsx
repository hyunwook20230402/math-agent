import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Upload, Clipboard } from 'lucide-react';

const AddProblem = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  
  const [formData, setFormData] = useState({
    title: '',
    answer: '',
    answerType: 'short_answer' as 'short_answer' | 'multiple_choice',
    difficulty: 1,
    category: ''
  });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [clipboardLoading, setClipboardLoading] = useState(false);

  // 클립보드에서 이미지 읽기 함수
  const handleClipboardImage = async () => {
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

  // paste 이벤트로 클립보드 이미지 처리
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;

    setLoading(true);
    try {
      let imageUrl = null;
      
      // Upload image if provided
      if (imageFile) {
        const fileExt = imageFile.name.split('.').pop();
        const fileName = `${Math.random()}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from('problem-images')
          .upload(fileName, imageFile);
        
        if (uploadError) throw uploadError;
        
        const { data: { publicUrl } } = supabase.storage
          .from('problem-images')
          .getPublicUrl(fileName);
        
        imageUrl = publicUrl;
      }

      // Insert problem
      const { error } = await supabase
        .from('problems')
        .insert({
          title: formData.title,
          unit: formData.category || '기타',
          difficulty: formData.difficulty === 1 ? 'easy' : formData.difficulty === 2 ? 'medium' : 'hard',
          answer_type: formData.answerType,
          correct_answer: formData.answer,
          image_url: imageUrl || '',
          problem_number: 1,
          teacher_id: profile.id,
          explanation: '',
        });

      if (error) throw error;

      toast({
        title: "문제 등록 완료",
        description: "새로운 문제가 성공적으로 등록되었습니다."
      });

      navigate('/');
    } catch (error: any) {
      toast({
        title: "오류",
        description: error.message || "문제 등록 중 오류가 발생했습니다.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center mb-6">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => navigate('/')}
            className="mr-4"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            대시보드로 돌아가기
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl font-bold text-center">새 문제 등록</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <Label htmlFor="title">문제</Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="문제를 입력하세요"
                  required
                />
              </div>

              <div>
                <Label htmlFor="answerType">답안 유형</Label>
                <Select 
                  value={formData.answerType} 
                  onValueChange={(value: 'short_answer' | 'multiple_choice') => 
                    setFormData(prev => ({ ...prev, answerType: value, answer: '' }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="답안 유형을 선택하세요" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="short_answer">주관식</SelectItem>
                    <SelectItem value="multiple_choice">객관식</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="answer">정답</Label>
                {formData.answerType === 'multiple_choice' ? (
                  <Select 
                    value={formData.answer} 
                    onValueChange={(value) => setFormData(prev => ({ ...prev, answer: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="정답을 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1번</SelectItem>
                      <SelectItem value="2">2번</SelectItem>
                      <SelectItem value="3">3번</SelectItem>
                      <SelectItem value="4">4번</SelectItem>
                      <SelectItem value="5">5번</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="answer"
                    value={formData.answer}
                    onChange={(e) => setFormData(prev => ({ ...prev, answer: e.target.value }))}
                    placeholder="정답을 입력하세요"
                    required
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="category">카테고리</Label>
                  <Input
                    id="category"
                    value={formData.category}
                    onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                    placeholder="예: 대수학, 기하학"
                  />
                </div>
                <div>
                  <Label htmlFor="difficulty">난이도 (1-5)</Label>
                  <Input
                    id="difficulty"
                    type="number"
                    min="1"
                    max="5"
                    value={formData.difficulty}
                    onChange={(e) => setFormData(prev => ({ ...prev, difficulty: parseInt(e.target.value) }))}
                  />
                </div>
              </div>



              <div>
                <Label htmlFor="image">문제 이미지 (선택)</Label>
                <div 
                  className="mt-2 border-2 border-dashed border-border rounded-lg p-4 text-center"
                  onPaste={handlePaste}
                  tabIndex={0}
                >
                  <input
                    id="image"
                    type="file"
                    accept="image/*"
                    onChange={(e) => setImageFile(e.target.files?.[0] || null)}
                    className="hidden"
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
                    <label htmlFor="image" className="cursor-pointer">
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
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <div className="flex items-center">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    등록 중...
                  </div>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    문제 등록
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AddProblem;